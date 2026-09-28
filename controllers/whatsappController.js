// src/controllers/whatsappController.js
//
// The webhook, and the read APIs over sessions and messages.
//
// FIVE RULES THIS CONTROLLER FOLLOWS, and why
//
// 1. ALWAYS ANSWER META WITH 200. Meta retries non-2xx responses with growing
//    delay and eventually disables the webhook. A database outage must not cost
//    us the integration, so processing failures are logged and answered 200.
//    The only non-200 is 403 for a signature that does not verify — that request
//    did not come from Meta, so Meta's retry policy is irrelevant.
//
// 2. VERIFY THE SIGNATURE FIRST, over the raw body. See utils/whatsapp/signature.js.
//
// 3. ARCHIVE BEFORE PROCESSING. The inbound row is written before the engine
//    runs, so a crash leaves evidence of what the customer sent.
//
// 4. ONE CUSTOMER AT A TIME. withNumberLock serialises concurrent messages from
//    the same number; without it, two messages 200ms apart would both read the
//    same step and advance the flow twice.
//
// 5. NEVER LEAK AN ERROR TO THE CUSTOMER. Any unexpected failure sends the
//    translated system.error message, not a stack trace.
//
import { getWhatsAppConfig } from "../utils/appSettings.js";
import { verifySignature, verifyTokenMatches, SIGNATURE_HEADER } from "../utils/whatsapp/signature.js";
import { parseWebhookPayload } from "../utils/whatsapp/parser.js";
import { processMessage } from "../utils/whatsapp/engine.js";
import { FLOW, mergeFlowDefinition } from "../utils/whatsapp/flow.default.js";
import { sendText, sendButtons, sendList, markRead } from "../utils/whatsapp/client.js";
import { translator } from "../utils/i18n.js";
import {
  withNumberLock,
  getActiveSession,
  createSession,
  updateSession,
  incrementCustomerMessageCount,
  recordInboundMessage,
  applyStatusUpdate,
  expireStaleSessions,
  listSessions,
  getSessionById,
  listSessionMessages,
  getMessageCountStats,
  pruneOldMessages,
} from "../models/whatsappModel.js";
import { getCountries, getDestinations, getCountryByCode } from "../utils/referenceData.js";
import { listWhatsAppPlans, createQuote } from "../models/quoteModel.js";
import getPool from "../utils/db.js";
import { captureException } from "../utils/monitoring.js";

const ok = (res, data, extra = {}) => res.json({ success: true, data, ...extra });
const fail = (res, status, code, message, extra = {}) =>
  res.status(status).json({ success: false, error: { code, message, ...extra } });

/* ------------------------------------------------ per-number rate limiting */

/**
 * The global express-rate-limit on /api is keyed by IP, and every webhook arrives
 * from Meta's IPs — so it would either never trigger or throttle every customer
 * at once. This limits an individual PHONE NUMBER instead, which is the thing that
 * can actually flood us.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_NUMBER = 20;
const numberBuckets = new Map();

function numberRateExceeded(waNumber) {
  const now = Date.now();
  const bucket = numberBuckets.get(waNumber) || { resetAt: now + RATE_WINDOW_MS, count: 0 };
  if (now >= bucket.resetAt) {
    bucket.resetAt = now + RATE_WINDOW_MS;
    bucket.count = 0;
  }
  bucket.count += 1;
  numberBuckets.set(waNumber, bucket);

  // Opportunistic cleanup so the map cannot grow without bound.
  if (numberBuckets.size > 5000) {
    for (const [key, value] of numberBuckets) {
      if (now >= value.resetAt) numberBuckets.delete(key);
    }
  }
  return bucket.count > RATE_MAX_PER_NUMBER;
}

/* ------------------------------------------------------ GET /webhook (setup) */

export const verifyWebhook = async (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    const config = await getWhatsAppConfig();
    if (!config.verifyToken) {
      console.warn("WhatsApp webhook verification attempted but no verify token is configured");
      return res.sendStatus(403);
    }
    if (mode === "subscribe" && verifyTokenMatches(token, config.verifyToken)) {
      // Meta expects the challenge echoed as plain text, not JSON.
      return res.status(200).type("text/plain").send(String(challenge ?? ""));
    }
    return res.sendStatus(403);
  } catch (err) {
    console.error("WhatsApp webhook verification failed:", err);
    return res.sendStatus(403);
  }
};

/* ------------------------------------------------------ POST /webhook (events) */

export const receiveWebhook = async (req, res) => {
  let config;
  try {
    config = await getWhatsAppConfig();
  } catch (err) {
    console.error("WhatsApp webhook: settings unavailable:", err.message);
    return res.sendStatus(200); // rule 1
  }

  // `req.body` is a Buffer here: the route is mounted with express.raw so the
  // bytes are intact for signature verification.
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""), "utf8");

  const signature = verifySignature(rawBody, req.headers[SIGNATURE_HEADER], config.appSecret);
  if (!signature.valid) {
    console.warn(`WhatsApp webhook rejected: ${signature.reason}`);
    return res.sendStatus(403); // rule 2 — not from Meta, so no retry concern
  }

  // Answer Meta immediately, then do the work. Meta's timeout is short and a
  // conversation step involves several outbound API calls of our own.
  res.sendStatus(200);

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    console.error("WhatsApp webhook: body was not valid JSON");
    return;
  }

  try {
    await handleWebhookPayload(payload, config);
  } catch (err) {
    // The customer already got their 200; without reporting, this failure would
    // be invisible until someone noticed conversations going quiet.
    captureException(err, { scope: "whatsapp_webhook_processing" });
  }
};

async function handleWebhookPayload(payload, config) {
  const parsed = parseWebhookPayload(payload);

  // Delivery receipts: cheap, and they are how we know a send failed.
  for (const status of parsed.statuses) {
    await applyStatusUpdate({
      waMessageId: status.waMessageId,
      status: status.status,
      errorCode: status.errorCode,
      errorMessage: status.errorMessage,
    }).catch((err) => console.warn("status update failed:", err.message));
  }

  for (const error of parsed.errors) {
    console.error("WhatsApp webhook reported an error:", error);
  }

  if (!parsed.messages.length) return;

  // Housekeeping runs on the back of real traffic rather than a cron: no extra
  // moving part to deploy, and it only costs one UPDATE per webhook batch.
  await expireStaleSessions().catch(() => {});

  for (const message of parsed.messages) {
    await handleSingleMessage(message, config);
  }
}

async function handleSingleMessage(message, config) {
  const waNumber = message.from;
  if (!waNumber) return;

  if (numberRateExceeded(waNumber)) {
    console.warn(`WhatsApp: rate limit hit for ${waNumber}; message archived but not processed`);
    await recordInboundMessage({
      waNumber,
      waMessageId: message.waMessageId,
      messageType: message.rawType,
      body: message.text,
      payload: { rateLimited: true },
    }).catch(() => {});
    return;
  }

  // The flow can be switched off while credentials stay saved.
  if (!config.enabled) return;
  if (!config.ready) {
    console.warn("WhatsApp: message received but the integration is not fully configured:", config.missing.join(", "));
    return;
  }

  const lock = await withNumberLock(waNumber, async () => {
    let session = await getActiveSession(waNumber);

    // Rule 3: archive first, and use the archive for deduplication.
    const archived = await recordInboundMessage({
      sessionId: session?.id || null,
      waNumber,
      waMessageId: message.waMessageId,
      messageType: message.rawType,
      body: message.text || message.selectionTitle || null,
      payload: message.raw || null,
      stepKey: session?.currentStep || null,
    });
    if (archived.duplicate) {
      console.log(`WhatsApp: ignoring duplicate delivery of ${message.waMessageId}`);
      return { duplicate: true };
    }

    await markRead(message.waMessageId, { config });

    if (!session) {
      session = await createSession({
        waNumber,
        profileName: message.profileName,
        language: config.defaultLanguage,
        timeoutHours: config.sessionTimeoutHours,
      });
    }

    const ctx = {
      flow: await loadFlow(),
      config,
      now: new Date(),
      deps: {
        getCountries,
        getDestinations,
        getCountryByCode,
        getPlans: listWhatsAppPlans,
        persistQuote: ({ collectedData }) =>
          createQuote({
            traveller: {
              first_name: collectedData.first_name,
              last_name: collectedData.last_name,
              date_of_birth: collectedData.date_of_birth,
              gender: collectedData.gender,
              nationality: collectedData.nationality,
              country_of_residence: collectedData.country_of_residence,
              passport_or_id: collectedData.passport_or_id,
              email: collectedData.email,
              phone: collectedData.phone || `+${waNumber}`,
              whatsapp_number: waNumber,
              preferred_language: session.language,
            },
            travel: {
              destination: collectedData.destination,
              destination_code: collectedData.destination_code,
              start_date: collectedData.start_date,
              end_date: collectedData.end_date,
            },
            planId: collectedData.plan_id,
            createdBy: config.attributionUserId,
            source: "whatsapp",
          }),
      },
    };

    let result;
    try {
      result = await processMessage({ message, session, ctx });
    } catch (err) {
      // Rule 5: the customer gets a sentence, we get the stack trace.
      captureException(err, { scope: "whatsapp_engine", waNumber, sessionId: session.id, step: session.currentStep });
      const t = translator(session.language);
      await sendText({ to: waNumber, text: t("system.error"), sessionId: session.id, config }).catch(() => {});
      return { error: true };
    }

    if (Object.keys(result.patch || {}).length) {
      await updateSession(session.id, { ...result.patch, timeoutHours: config.sessionTimeoutHours });
    }
    if (result.countsAsCustomerMessage) {
      await incrementCustomerMessageCount(session.id);
    }

    for (const event of result.events || []) {
      console.log(`WhatsApp event [${event.type}]`, { waNumber, ...(event.data || {}) });
    }

    for (const reply of result.replies || []) {
      await deliverReply(reply, { waNumber, sessionId: session.id, config });
    }

    return { ok: true };
  });

  if (!lock.ran) {
    console.warn(`WhatsApp: could not acquire the conversation lock for ${waNumber}; message archived only`);
  }
}

async function deliverReply(reply, { waNumber, sessionId, config }) {
  try {
    if (reply.kind === "buttons") {
      return await sendButtons({
        to: waNumber, body: reply.body, buttons: reply.buttons,
        sessionId, stepKey: reply.stepKey, config,
      });
    }
    if (reply.kind === "list") {
      return await sendList({
        to: waNumber, body: reply.body, sections: reply.sections,
        buttonText: reply.buttonText, sessionId, stepKey: reply.stepKey, config,
      });
    }
    return await sendText({ to: waNumber, text: reply.body, sessionId, stepKey: reply.stepKey, config });
  } catch (err) {
    console.error("WhatsApp: failed to deliver a reply:", err.message);
    return { ok: false };
  }
}

/**
 * The active flow definition: a row in `whatsapp_flows` if the superadmin has
 * customised it, otherwise the built-in one. Unknown steps and parsers in a
 * stored definition are ignored by mergeFlowDefinition rather than trusted.
 */
async function loadFlow() {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT definition FROM whatsapp_flows WHERE flow_key = ? AND active = 1 LIMIT 1`,
      [FLOW.key]
    );
    if (!rows.length) return FLOW;
    const definition = typeof rows[0].definition === "string" ? JSON.parse(rows[0].definition) : rows[0].definition;
    return mergeFlowDefinition(definition);
  } catch (err) {
    console.warn("WhatsApp: could not load the stored flow, using the built-in one:", err.message);
    return FLOW;
  }
}

/* --------------------------------------------------------------- read APIs */

export const getSessions = async (req, res) => {
  try {
    const result = await listSessions({
      page: req.query.page,
      limit: req.query.limit,
      status: req.query.status || null,
      search: req.query.search || "",
    });
    return ok(res, result.sessions, { pagination: result.pagination });
  } catch (err) {
    console.error("getSessions failed:", err);
    return fail(res, 500, "sessions_read_failed", "Could not load the conversations");
  }
};

export const getSession = async (req, res) => {
  try {
    const session = await getSessionById(Number(req.params.id));
    if (!session) return fail(res, 404, "not_found", "Conversation not found");
    return ok(res, session);
  } catch (err) {
    console.error("getSession failed:", err);
    return fail(res, 500, "session_read_failed", "Could not load the conversation");
  }
};

export const getSessionMessages = async (req, res) => {
  try {
    const session = await getSessionById(Number(req.params.id));
    if (!session) return fail(res, 404, "not_found", "Conversation not found");
    const messages = await listSessionMessages(session.id, { limit: req.query.limit });
    return ok(res, messages, { session: { id: session.id, waNumber: session.waNumber, status: session.status } });
  } catch (err) {
    console.error("getSessionMessages failed:", err);
    return fail(res, 500, "messages_read_failed", "Could not load the messages");
  }
};

/** Outbound send for partners and internal tooling (scope whatsapp:write). */
export const sendMessage = async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!to || !String(to).trim()) return fail(res, 400, "validation_error", "`to` is required");
    if (!text || !String(text).trim()) return fail(res, 400, "validation_error", "`text` is required");

    const config = await getWhatsAppConfig();
    if (!config.ready) {
      return fail(res, 503, "not_configured", "The WhatsApp integration is not fully configured", {
        missing: config.missing,
      });
    }

    const waNumber = String(to).replace(/[^\d]/g, "");
    const session = await getActiveSession(waNumber);
    const result = await sendText({
      to: waNumber,
      text: String(text),
      sessionId: session?.id || null,
      config,
    });

    if (!result.ok) {
      return fail(res, 502, result.code || "send_failed", result.message || "Meta rejected the message");
    }
    return ok(res, { waMessageId: result.waMessageId, to: waNumber });
  } catch (err) {
    console.error("sendMessage failed:", err);
    return fail(res, 500, "send_failed", "Could not send the message");
  }
};

/** Non-secret runtime status, safe for a partner integration to poll. */
export const getPublicStatus = async (_req, res) => {
  try {
    const config = await getWhatsAppConfig();
    return ok(res, {
      enabled: config.enabled,
      ready: config.ready,
      businessNumber: config.businessNumber,
      defaultLanguage: config.defaultLanguage,
      supportedLanguages: ["fr", "en"],
      sessionTimeoutHours: config.sessionTimeoutHours,
    });
  } catch (err) {
    console.error("getPublicStatus failed:", err);
    return fail(res, 500, "status_failed", "Could not read the status");
  }
};

export const getStats = async (req, res) => {
  try {
    const stats = await getMessageCountStats({ days: req.query.days });
    return ok(res, { ...stats, target: { min: 6, max: 8 } });
  } catch (err) {
    console.error("getStats failed:", err);
    return fail(res, 500, "stats_failed", "Could not compute the statistics");
  }
};

/**
 * Apply the retention policy. Admin-triggered, and the only operation in the
 * module that deletes anything — transcripts only, never a case or a sale.
 */
export const pruneMessages = async (req, res) => {
  try {
    const config = await getWhatsAppConfig();
    const deleted = await pruneOldMessages(config.messageRetentionDays);
    return ok(res, { deleted, retentionDays: config.messageRetentionDays });
  } catch (err) {
    console.error("pruneMessages failed:", err);
    return fail(res, 500, "prune_failed", "Could not apply the retention policy");
  }
};
