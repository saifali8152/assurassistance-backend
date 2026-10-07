// src/controllers/paymentWebhookController.js
//
// The one endpoint every provider calls back on: /api/payments/webhook/:provider
//
// It follows the same five rules as the WhatsApp webhook, for the same reasons:
//
//   1. Always answer 200, except 403 on a bad signature. A provider that gets a
//      500 retries, and a retry storm during an outage is worse than the
//      outage.
//   2. Verify the signature over the RAW bytes, before anything else. The route
//      is mounted with express.raw() ahead of express.json() so those bytes
//      still exist.
//   3. Archive before processing. The raw body, the signature header and the
//      source IP are written first; a payload we cannot parse is exactly the
//      one a dispute will turn on.
//   4. One transaction at a time. The state machine's row lock serialises a
//      customer's own retry against the provider's redelivery.
//   5. Never leak an internal error outward. Failures go to the monitor.
//
// WHAT IT DOES NOT DO YET: issue the policy. The transition to `completed` is
// recorded here; turning that into a policy, a certificate and a WhatsApp
// document is Day 6, and it hangs off this same point.
//
import { getProvider } from "../utils/payments/index.js";
import { getProviderConfig } from "../utils/payments/config.js";
import {
  recordCallback,
  markCallbackProcessed,
  getTransactionByProviderTx,
  getTransactionByReference,
  transition,
} from "../models/paymentModel.js";
import { captureException } from "../utils/monitoring.js";
import { settlePayment } from "../utils/payments/service.js";

/**
 * Per-provider flood guard.
 *
 * The global IP limiter does not cover this route — it is mounted ahead of it so
 * the raw body survives — and a provider's callbacks all arrive from a handful
 * of its own IPs, so an IP-keyed limit would throttle every customer at once.
 * This bounds the damage from a misbehaving sender without doing that.
 */
const buckets = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 300;

function rateExceeded(provider) {
  const now = Date.now();
  const bucket = buckets.get(provider);
  if (!bucket || now - bucket.start > WINDOW_MS) {
    buckets.set(provider, { start: now, count: 1 });
    if (buckets.size > 50) {
      for (const [k, v] of buckets) if (now - v.start > WINDOW_MS) buckets.delete(k);
    }
    return false;
  }
  bucket.count += 1;
  return bucket.count > MAX_PER_WINDOW;
}

export const receivePaymentWebhook = async (req, res) => {
  const code = String(req.params.provider || "").toLowerCase();
  const provider = getProvider(code);
  if (!provider) {
    // Not an error worth retrying: the URL names a provider we do not have.
    return res.status(404).json({ success: false, error: { code: "unknown_provider" } });
  }

  const config = await getProviderConfig(code);
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""), "utf8");
  const headers = lowercaseHeaders(req.headers);
  const remoteIp = req.ip || req.socket?.remoteAddress || null;

  if (rateExceeded(code)) {
    // Archive it anyway — a flood is itself evidence — but do no work.
    await safeArchive({ provider: code, rawBody, headers, remoteIp, signatureValid: false });
    return res.sendStatus(200);
  }

  let parsed;
  try {
    parsed = provider.handleCallback({ rawBody, headers, config }) || {};
  } catch (err) {
    captureException(err, { scope: "payment_webhook_parse", provider: code });
    parsed = { valid: false, reason: "parser_threw" };
  }

  const archived = await safeArchive({
    provider: code,
    rawBody,
    headers,
    remoteIp,
    signatureValid: Boolean(parsed.valid),
    providerTxId: parsed.providerTxId || null,
  });

  if (!parsed.valid) {
    // 403 rather than 200: a wrong signature is the one case where the sender
    // should know it failed, and a provider resending a correctly signed
    // payload later is exactly what we want.
    return res.status(403).json({ success: false, error: { code: "invalid_signature", reason: parsed.reason } });
  }

  // Answer before working, so a slow database never turns into a provider
  // timeout and a duplicate delivery.
  res.sendStatus(200);

  try {
    await processCallback({ providerCode: code, parsed, archivedId: archived?.id, duplicate: archived?.duplicate });
  } catch (err) {
    captureException(err, { scope: "payment_webhook_processing", provider: code });
    if (archived?.id) {
      await markCallbackProcessed(archived.id, { error: err.message }).catch(() => {});
    }
  }
};

async function processCallback({ providerCode, parsed, archivedId, duplicate }) {
  if (duplicate) {
    // Already acted on. Recording that we saw it again is the whole response:
    // acting twice is how one payment becomes two policies.
    if (archivedId) await markCallbackProcessed(archivedId, { error: null });
    return;
  }

  const tx =
    (await getTransactionByProviderTx(providerCode, parsed.providerTxId)) ||
    (parsed.reference ? await getTransactionByReference(parsed.reference) : null);

  if (!tx) {
    if (archivedId) {
      await markCallbackProcessed(archivedId, { error: "no matching transaction" });
    }
    return;
  }

  const target = parsed.status;
  if (!target) {
    if (archivedId) await markCallbackProcessed(archivedId, { transactionId: tx.id, error: "callback carried no status" });
    return;
  }

  const result = await transition(tx.id, target, {
    by: `provider:${providerCode}`,
    note: parsed.failureCode || null,
    failureCode: parsed.failureCode || null,
    failureDetail: parsed.failureDetail || null,
  });

  if (archivedId) {
    await markCallbackProcessed(archivedId, {
      transactionId: tx.id,
      error: result.ok ? null : `${result.reason}: ${result.message}`,
    });
  }

  // Only a REAL move settles. A no-op means we have already acted on this
  // outcome, and acting twice is how one payment becomes two policies — and how
  // a customer who paid once comes to believe they paid twice.
  if (result.ok && !result.noop) {
    await settlePayment({
      transactionId: tx.id,
      status: result.to,
      failureCode: parsed.failureCode || null,
    });
  }
}

async function safeArchive(args) {
  try {
    return await recordCallback({
      provider: args.provider,
      rawBody: args.rawBody,
      signatureHeader: firstSignatureHeader(args.headers),
      signatureValid: args.signatureValid,
      providerTxId: args.providerTxId || null,
      contentType: args.headers["content-type"] || null,
      remoteIp: args.remoteIp,
    });
  } catch (err) {
    // The archive failing must not swallow the callback: log it and carry on,
    // because refusing the delivery would make the provider retry into the same
    // broken write.
    captureException(err, { scope: "payment_webhook_archive", provider: args.provider });
    return null;
  }
}

function lowercaseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k.toLowerCase()] = v;
  return out;
}

/** Whichever signature header this provider used, for the archive. */
function firstSignatureHeader(headers) {
  const key = Object.keys(headers).find((k) => k.includes("signature"));
  return key ? String(headers[key]).slice(0, 255) : null;
}

export const __testables = { rateExceeded, lowercaseHeaders, firstSignatureHeader };
