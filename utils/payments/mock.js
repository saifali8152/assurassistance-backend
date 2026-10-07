// src/utils/payments/mock.js
//
// A provider that behaves like a mobile money API without one.
//
// This is not a stub for convenience. The milestone's Day 1-2 exit criterion is
// that the abstraction layer passes a full end-to-end test INCLUDING duplicate
// callbacks and timeouts, and no real provider can be made to produce those on
// demand. The outcome is chosen by the last four digits of the number being
// charged, so a test — or a developer on a phone — can force any branch:
//
//   …0000  pays immediately
//   …1111  insufficient funds
//   …2222  wrong PIN
//   …3333  the customer cancels
//   …4444  the customer never responds (nothing calls back; the sweeper expires it)
//   …9999  the provider itself is down
//   anything else  prompt sent, settles when the callback arrives
//
// It registers itself on import, and index.js only imports it outside
// production (or when PAYMENT_ALLOW_MOCK is set), so it cannot reach a live
// customer by accident.
//
import crypto from "crypto";
import { registerProvider } from "./provider.js";
import { verifyHmac, signBody } from "./signature.js";

const SIGNATURE_HEADER = "x-mock-signature";

/** The branch a number selects. */
export function outcomeFor(msisdn) {
  const tail = String(msisdn || "").slice(-4);
  switch (tail) {
    case "0000": return { status: "completed" };
    case "1111": return { status: "failed", failureCode: "insufficient_funds" };
    case "2222": return { status: "failed", failureCode: "wrong_pin" };
    case "3333": return { status: "cancelled", failureCode: "customer_cancelled" };
    case "4444": return { status: "awaiting_confirmation", silent: true };
    case "9999": return { status: "failed", failureCode: "provider_unavailable" };
    default: return { status: "awaiting_confirmation" };
  }
}

const mockProvider = {
  code: "mock",
  label: "Mock provider",

  async initiatePayment({ reference, amount, currency, msisdn }) {
    const outcome = outcomeFor(msisdn);

    if (outcome.failureCode === "provider_unavailable") {
      return {
        ok: false,
        status: "failed",
        failureCode: "provider_unavailable",
        failureDetail: "Mock provider is simulating an outage",
        raw: { reference },
      };
    }

    // A real provider returns its own id here; ours is derived from the
    // reference so a test can predict it without reading the database.
    const providerTxId = `mock_${crypto.createHash("sha1").update(reference).digest("hex").slice(0, 16)}`;

    return {
      ok: true,
      providerTxId,
      // Even a number that will ultimately succeed goes through the waiting
      // state: the prompt genuinely is on the handset for a moment, and a flow
      // that skipped it would never exercise the path that matters.
      status: "awaiting_confirmation",
      customerHint: `Confirm ${amount} ${currency} on your handset`,
      raw: { reference, providerTxId, amount, currency, msisdn },
    };
  },

  async checkStatus({ providerTxId, reference, msisdn }) {
    const outcome = outcomeFor(msisdn);
    return {
      ok: true,
      providerTxId,
      status: outcome.silent ? "awaiting_confirmation" : outcome.status,
      ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
      raw: { reference, providerTxId, polled: true },
    };
  },

  /**
   * Verify and parse a callback. Pure: it reads bytes and headers and returns
   * what it found. Deciding what to do about it is the model's job.
   */
  handleCallback({ rawBody, headers, config }) {
    const check = verifyHmac({
      rawBody,
      signature: headers?.[SIGNATURE_HEADER] || headers?.[SIGNATURE_HEADER.toUpperCase()],
      secret: config?.callbackSecret,
    });
    if (!check.valid) return { valid: false, reason: check.reason };

    let payload;
    try {
      payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
    } catch {
      return { valid: true, reason: "unparseable_body", payload: null };
    }

    return {
      valid: true,
      providerTxId: payload.provider_tx_id || null,
      reference: payload.reference || null,
      status: payload.status || null,
      failureCode: payload.failure_code || null,
      payload,
    };
  },

  async refund() {
    // Honest rather than silently successful: refunds are out of contract for
    // this milestone, and a provider that pretends to refund is worse than one
    // that says it cannot.
    return { ok: false, status: "failed", failureCode: "provider_rejected", failureDetail: "Refunds are not implemented" };
  },
};

/** Test helper: build the body and header a mock callback would arrive with. */
export function buildMockCallback({ reference, providerTxId, status, failureCode, secret }) {
  const body = JSON.stringify({
    reference,
    provider_tx_id: providerTxId,
    status,
    ...(failureCode ? { failure_code: failureCode } : {}),
  });
  return {
    body,
    headers: { [SIGNATURE_HEADER]: signBody({ rawBody: body, secret }) },
  };
}

export { SIGNATURE_HEADER };
export default registerProvider(mockProvider);
