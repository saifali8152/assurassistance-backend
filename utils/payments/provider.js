// src/utils/payments/provider.js
//
// The provider contract and the registry that resolves one by code.
//
// WHY A COMMON LAYER FIRST: four integrations written one at a time become four
// incompatible shapes, and the differences leak into the conversation, the
// state machine and the reconciliation report. Everything provider-specific
// lives behind this interface; everything above it deals in one vocabulary.
//
// Every method is PURE with respect to our database. A provider talks HTTP and
// returns a result; it never writes a row, never decides whether a policy is
// issued, and never touches a session. That is the model's job, and it is what
// makes a provider testable without a database.
//
import { PAYMENT_STATES } from "./stateMachine.js";

/**
 * The internal failure vocabulary. Every provider maps its own codes onto
 * these, so the customer-facing message is written once per reason rather than
 * once per provider.
 */
export const FAILURE_CODES = [
  "insufficient_funds",
  "wrong_pin",
  "customer_cancelled",
  "customer_timeout",
  "invalid_number",
  "limit_exceeded",
  "duplicate_transaction",
  "provider_unavailable",
  "provider_rejected",
  "configuration_error",
  "unknown",
];

export function isKnownFailure(code) {
  return FAILURE_CODES.includes(code);
}

/**
 * @typedef {object} InitiateRequest
 * @property {string} reference      our reference, shown to the customer
 * @property {number} amount         major units, e.g. 15000
 * @property {string} currency       ISO 4217
 * @property {string} msisdn         number to charge, E.164 without '+'
 * @property {string} description    shown on the customer's handset where supported
 * @property {string} callbackUrl    absolute URL the provider should call
 * @property {object} config         resolved provider settings
 *
 * @typedef {object} ProviderResult
 * @property {boolean} ok            did the call itself succeed
 * @property {string}  [providerTxId] the provider's own id, when it gives one
 * @property {string}  status        one of PAYMENT_STATES
 * @property {string}  [failureCode] one of FAILURE_CODES, when status is failed
 * @property {string}  [failureDetail]
 * @property {string}  [customerHint] extra instruction, e.g. "dial *144#"
 * @property {object}  [raw]         the provider's payload, for the archive
 *
 * @typedef {object} PaymentProvider
 * @property {string} code
 * @property {string} label
 * @property {(req: InitiateRequest) => Promise<ProviderResult>} initiatePayment
 * @property {(req: {providerTxId?: string, reference: string, config: object}) => Promise<ProviderResult>} checkStatus
 * @property {(req: {rawBody: Buffer, headers: object, config: object}) => CallbackResult} handleCallback
 * @property {(req: {providerTxId: string, amount: number, config: object}) => Promise<ProviderResult>} refund
 *
 * @typedef {object} CallbackResult
 * @property {boolean} valid          did the signature verify
 * @property {string}  [reason]       why it did not
 * @property {string}  [providerTxId]
 * @property {string}  [reference]
 * @property {string}  [status]
 * @property {string}  [failureCode]
 * @property {object}  [payload]
 */

const registry = new Map();

/**
 * Register an implementation. Called once per provider at import time.
 * Validates the shape immediately, because a provider missing a method is a
 * deploy-time mistake that must not wait until a customer is mid-payment.
 */
export function registerProvider(impl) {
  if (!impl || typeof impl !== "object") throw new Error("Provider must be an object");
  if (!impl.code) throw new Error("Provider must declare a code");
  for (const method of ["initiatePayment", "checkStatus", "handleCallback"]) {
    if (typeof impl[method] !== "function") {
      throw new Error(`Provider ${impl.code} is missing ${method}()`);
    }
  }
  if (registry.has(impl.code)) {
    throw new Error(`Provider ${impl.code} is already registered`);
  }
  registry.set(impl.code, impl);
  return impl;
}

export function getProvider(code) {
  return registry.get(String(code || "").toLowerCase()) || null;
}

export function listProviders() {
  return [...registry.values()];
}

/** Test helper — the registry is module state, so suites need a way to reset. */
export function __resetRegistry() {
  registry.clear();
}

/**
 * Normalise whatever a provider returns, so one provider cannot put an unknown
 * status or failure code into the state machine.
 */
export function normaliseResult(result, providerCode) {
  const out = { ...result };
  if (!PAYMENT_STATES.includes(out.status)) {
    out.status = "failed";
    out.failureCode = "provider_rejected";
    out.failureDetail = `${providerCode} returned an unrecognised status: ${result?.status}`;
    out.ok = false;
  }
  if (out.failureCode && !isKnownFailure(out.failureCode)) {
    out.failureDetail = [out.failureCode, out.failureDetail].filter(Boolean).join(": ");
    out.failureCode = "unknown";
  }
  return out;
}
