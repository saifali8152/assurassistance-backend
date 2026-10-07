// tests/payments.test.mjs
//
// The payment abstraction layer, tested without a provider and without a
// database. What is pinned here is the behaviour that decides whether one
// payment can become two policies.
//
import test from "node:test";
import assert from "node:assert/strict";

import {
  PAYMENT_STATES,
  TRANSITIONS,
  TERMINAL_STATES,
  canTransition,
  isTerminal,
  historyEntry,
  appendHistory,
} from "../utils/payments/stateMachine.js";
import { verifyHmac, signBody } from "../utils/payments/signature.js";
import {
  registerProvider,
  getProvider,
  normaliseResult,
  FAILURE_CODES,
  __resetRegistry,
} from "../utils/payments/provider.js";
import { __testables as configTestables } from "../utils/payments/config.js";

/* ------------------------------------------------------------ state machine */

test("every state has a transition list", () => {
  for (const s of PAYMENT_STATES) {
    assert.ok(Array.isArray(TRANSITIONS[s]), `${s} has no transition list`);
  }
});

test("completed is terminal and cannot be undone by a late callback", () => {
  // A provider re-sending a contradictory outcome must never revoke a policy
  // the customer is already travelling on.
  const r = canTransition("completed", "failed");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "terminal_state");
});

test("all four endings are terminal", () => {
  assert.deepEqual(TERMINAL_STATES, ["completed", "failed", "expired", "cancelled"]);
  for (const s of TERMINAL_STATES) assert.ok(isTerminal(s));
});

test("a callback that beats our own initiation response is still accepted", () => {
  // The provider can push the prompt, the customer can confirm, and the
  // callback can land before our initiate() call has returned. Refusing that
  // would strand a transaction the customer has already paid for.
  assert.ok(canTransition("pending", "completed").ok);
  assert.ok(canTransition("pending", "awaiting_confirmation").ok);
});

test("what protects the money is that completed is write-once, not the path to it", () => {
  // Only a verified callback or a provider status poll may write `completed`;
  // once written, nothing moves it.
  for (const s of ["failed", "expired", "cancelled", "initiated", "pending"]) {
    assert.equal(canTransition("completed", s).ok, false, `completed must not reach ${s}`);
  }
});

test("a failed payment cannot later be completed", () => {
  // A provider sending success after failure is contradicting itself; the
  // archive keeps both and a human decides.
  assert.equal(canTransition("failed", "completed").ok, false);
});

test("the happy path is legal end to end", () => {
  assert.ok(canTransition("pending", "initiated").ok);
  assert.ok(canTransition("initiated", "awaiting_confirmation").ok);
  assert.ok(canTransition("awaiting_confirmation", "completed").ok);
});

test("a repeated callback reporting the same state is a no-op, not an error", () => {
  const r = canTransition("awaiting_confirmation", "awaiting_confirmation");
  assert.equal(r.ok, true);
  assert.equal(r.noop, true);
});

test("an unknown state is refused rather than written", () => {
  assert.equal(canTransition("pending", "settled").ok, false);
  assert.equal(canTransition("nonsense", "completed").ok, false);
});

test("every terminal state is reachable from awaiting_confirmation", () => {
  for (const s of ["completed", "failed", "expired", "cancelled"]) {
    assert.ok(canTransition("awaiting_confirmation", s).ok, `cannot reach ${s}`);
  }
});

/* ------------------------------------------------------------------ history */

test("history records both ends of a move", () => {
  const e = historyEntry("initiated", "completed", { by: "provider:mock", note: "ok" });
  assert.equal(e.from, "initiated");
  assert.equal(e.to, "completed");
  assert.equal(e.by, "provider:mock");
  assert.match(e.at, /^\d{4}-\d{2}-\d{2}T/);
});

test("history appends to an existing array and to a JSON string alike", () => {
  const e = historyEntry("pending", "initiated");
  assert.equal(appendHistory([{ from: "a", to: "b" }], e).length, 2);
  assert.equal(appendHistory(JSON.stringify([{ from: "a", to: "b" }]), e).length, 2);
});

test("a corrupt history does not block a payment from progressing", () => {
  // Money must keep moving even if an old row holds something unparseable.
  const out = appendHistory("{not json", historyEntry("pending", "initiated"));
  assert.equal(out.length, 1);
});

test("history is capped so a retrying provider cannot grow one row forever", () => {
  let list = [];
  for (let i = 0; i < 150; i++) list = appendHistory(list, historyEntry("pending", "initiated"));
  assert.equal(list.length, 100);
});

/* ---------------------------------------------------------------- signature */

const BODY = JSON.stringify({ reference: "PAY-2026-000001", status: "completed" });

test("a correctly signed body verifies", () => {
  const sig = signBody({ rawBody: BODY, secret: "s3cr3t" });
  assert.equal(verifyHmac({ rawBody: BODY, signature: sig, secret: "s3cr3t" }).valid, true);
});

test("hex case does not matter", () => {
  const sig = signBody({ rawBody: BODY, secret: "s3cr3t" }).toUpperCase();
  assert.equal(verifyHmac({ rawBody: BODY, signature: sig, secret: "s3cr3t" }).valid, true);
});

test("base64 digests verify too, because providers disagree on encoding", () => {
  const sig = signBody({ rawBody: BODY, secret: "s3cr3t", encoding: "base64" });
  assert.equal(verifyHmac({ rawBody: BODY, signature: sig, secret: "s3cr3t", encoding: "base64" }).valid, true);
});

test("a prefix is stripped, and a wrong prefix is refused", () => {
  const sig = signBody({ rawBody: BODY, secret: "s3cr3t", prefix: "sha256=" });
  assert.equal(verifyHmac({ rawBody: BODY, signature: sig, secret: "s3cr3t", prefix: "sha256=" }).valid, true);
  assert.equal(
    verifyHmac({ rawBody: BODY, signature: sig, secret: "s3cr3t", prefix: "sha512=" }).reason,
    "unexpected_signature_prefix"
  );
});

test("a tampered body fails", () => {
  const sig = signBody({ rawBody: BODY, secret: "s3cr3t" });
  assert.equal(verifyHmac({ rawBody: BODY + " ", signature: sig, secret: "s3cr3t" }).valid, false);
});

test("an unconfigured secret fails closed rather than accepting anything", () => {
  const sig = signBody({ rawBody: BODY, secret: "s3cr3t" });
  const r = verifyHmac({ rawBody: BODY, signature: sig, secret: "" });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "secret_not_configured");
});

test("a missing header fails", () => {
  assert.equal(verifyHmac({ rawBody: BODY, signature: "", secret: "s" }).reason, "signature_header_missing");
});

/* ----------------------------------------------------------------- registry */

test("a provider missing a method is rejected at registration", () => {
  __resetRegistry();
  assert.throws(() => registerProvider({ code: "half", initiatePayment: () => {} }), /missing checkStatus/);
});

test("the same provider cannot be registered twice", () => {
  __resetRegistry();
  const impl = { code: "dup", initiatePayment() {}, checkStatus() {}, handleCallback() {} };
  registerProvider(impl);
  assert.throws(() => registerProvider({ ...impl }), /already registered/);
});

test("lookup is case-insensitive and misses return null", () => {
  __resetRegistry();
  registerProvider({ code: "wave", initiatePayment() {}, checkStatus() {}, handleCallback() {} });
  assert.equal(getProvider("WAVE").code, "wave");
  assert.equal(getProvider("nope"), null);
});

test("an unrecognised status from a provider becomes a failure, not a bad write", () => {
  const r = normaliseResult({ ok: true, status: "settled" }, "orange");
  assert.equal(r.status, "failed");
  assert.equal(r.failureCode, "provider_rejected");
  assert.equal(r.ok, false);
});

test("an unrecognised failure code is kept as detail and mapped to unknown", () => {
  const r = normaliseResult({ ok: false, status: "failed", failureCode: "E_WEIRD" }, "mtn");
  assert.equal(r.failureCode, "unknown");
  assert.equal(r.failureDetail, "E_WEIRD");
});

test("a known failure code passes through untouched", () => {
  const r = normaliseResult({ ok: false, status: "failed", failureCode: "insufficient_funds" }, "mtn");
  assert.equal(r.failureCode, "insufficient_funds");
  assert.ok(FAILURE_CODES.includes(r.failureCode));
});

/* ------------------------------------------------------------------- config */

test("country and prefix lists tolerate commas, spaces and casing", () => {
  assert.deepEqual(configTestables.parseList(" ci, sn  bf "), ["CI", "SN", "BF"]);
  assert.deepEqual(configTestables.parseList(null), []);
});

test("a provider with nothing configured reports exactly what it needs", () => {
  const cfg = configTestables.providerConfig({}, { code: "mtn", label: "MTN MoMo" });
  assert.deepEqual(cfg.missing, ["base_url", "api_key", "callback_secret", "countries"]);
  assert.equal(cfg.ready, false);
});

test("a fully configured but disabled provider is not ready", () => {
  const cfg = configTestables.providerConfig(
    {
      "payment.wave.base_url": "https://api.example",
      "payment.wave.api_key": "k",
      "payment.wave.callback_secret": "c",
      "payment.wave.countries": "SN",
    },
    { code: "wave", label: "Wave" }
  );
  assert.deepEqual(cfg.missing, []);
  assert.equal(cfg.ready, false, "disabled must not be ready");
});

test("a subscription key is not required, because only some providers issue one", () => {
  const cfg = configTestables.providerConfig(
    {
      "payment.orange.enabled": true,
      "payment.orange.base_url": "https://api.example",
      "payment.orange.api_key": "k",
      "payment.orange.callback_secret": "c",
      "payment.orange.countries": "CI,SN",
    },
    { code: "orange", label: "Orange Money" }
  );
  assert.equal(cfg.ready, true);
  assert.deepEqual(cfg.countries, ["CI", "SN"]);
});
