// tests/logging.test.mjs
//
// The redaction list is the reason utils/logger.js exists. A logger that prints
// an access token is worse than no logger, because the encryption work upstream
// then protects the database while the log file leaks the same value.
//
// pino applies its own `redact` config; these tests pin the CONSOLE FALLBACK,
// which is what runs on any environment that has not installed pino.
//
import test from "node:test";
import assert from "node:assert/strict";
import { createLogger, requestIdMiddleware, scrubText } from "../utils/logger.js";

/**
 * Run the real logger — same options, same redaction as the server — against a
 * sink we can read. pino writes straight to a file descriptor, so swapping
 * console would capture nothing.
 */
function capture(fn) {
  const lines = [];
  const sink = { write: (chunk) => lines.push(String(chunk)) };
  const testLogger = createLogger(sink);

  const consoleLines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (s) => consoleLines.push(String(s));
  try {
    fn(testLogger);
  } finally {
    Object.assign(console, original);
  }
  return [...lines, ...consoleLines].join("\n");
}

test("secrets never reach the log output", () => {
  const out = capture((logger) =>
    logger.info(
      {
        access_token: "EAAGsupersecret",
        app_secret: "meta-app-secret",
        verify_token: "aas_wh_tok",
        password: "hunter2",
        key_hash: "abc123",
        nested: { accessToken: "EAAGnested", authorization: "Bearer xyz" },
      },
      "settings saved"
    )
  );
  for (const secret of ["EAAGsupersecret", "meta-app-secret", "aas_wh_tok", "hunter2", "abc123", "EAAGnested", "Bearer xyz"]) {
    assert.ok(!out.includes(secret), `leaked: ${secret}`);
  }
  assert.ok(out.includes("[redacted]"));
  assert.ok(out.includes("settings saved"), "the message itself still logs");
});

test("a customer's phone number is NOT written to the log", () => {
  // This test used to assert the opposite — that the number survived. It was
  // pinning a leak: the WhatsApp module logs waNumber on every webhook, so a
  // server's log file accumulated the phone number of every customer who ever
  // wrote in.
  const out = capture((logger) => logger.info({ waNumber: "2250718923194", step: "email" }, "step advanced"));
  assert.ok(!out.includes("2250718923194"), "the number must not appear");
  assert.ok(out.includes("[redacted]"));
  assert.ok(out.includes("step advanced"), "the message itself still logs");
});

test("non-personal fields are untouched, so the logs stay useful", () => {
  const out = capture((logger) =>
    logger.info({ step: "payment_wait", provider: "orange", reference: "PAY-2026-000012" }, "advanced")
  );
  assert.ok(out.includes("payment_wait"));
  assert.ok(out.includes("orange"));
  assert.ok(out.includes("PAY-2026-000012"), "a payment reference is not personal data");
});

test("passport numbers and payment msisdns are redacted by field name", () => {
  const out = capture((logger) =>
    logger.info({ passport_or_id: "AB1234567", msisdn: "2250799887766", email: "x@y.test" }, "quote")
  );
  for (const v of ["AB1234567", "2250799887766", "x@y.test"]) {
    assert.ok(!out.includes(v), `leaked: ${v}`);
  }
});

test("a phone number inside a MESSAGE is masked too", () => {
  // Key-based redaction cannot help with console.log("inbound from", number) —
  // the number is an argument, not a field — and that is exactly the shape the
  // WhatsApp controller used.
  const out = capture((logger) => logger.info({}, "inbound from 2250718923194"));
  assert.ok(!out.includes("2250718923194"));
  assert.ok(out.includes("***94"), "enough is kept to match a support request");
});

test("scrubText masks phones and emails but leaves references alone", () => {
  assert.equal(scrubText("from 2250718923194"), "from ***94");
  assert.equal(scrubText("mail saif@devzz.tech now"), "mail s***@devzz.tech now");
  assert.equal(scrubText("policy AA-2026-000042"), "policy AA-2026-000042");
  assert.equal(scrubText("amount 15000 XOF"), "amount 15000 XOF");
  assert.equal(scrubText("+225 07 18 92 31 94"), "***94");
});

test("arrays and deep structures are walked", () => {
  const out = capture((logger) => logger.warn({ keys: [{ secret: "s1" }, { secret: "s2" }] }, "batch"));
  assert.ok(!out.includes("s1") && !out.includes("s2"));
});

test("request ids are assigned and echoed", () => {
  const headers = {};
  const req = { headers: {} };
  const res = { setHeader: (k, v) => (headers[k] = v) };
  let called = false;
  requestIdMiddleware(req, res, () => (called = true));
  assert.equal(called, true);
  assert.ok(typeof req.id === "string" && req.id.length >= 10);
  assert.equal(headers["X-Request-Id"], req.id);
});

test("an inbound request id is honoured, but a hostile one is not", () => {
  const req = { headers: { "x-request-id": "trace-abc-123" } };
  requestIdMiddleware(req, { setHeader: () => {} }, () => {});
  assert.equal(req.id, "trace-abc-123");

  const huge = { headers: { "x-request-id": "x".repeat(500) } };
  requestIdMiddleware(huge, { setHeader: () => {} }, () => {});
  assert.notEqual(huge.id, "x".repeat(500), "an oversized header must not be reflected");
  assert.ok(huge.id.length <= 64);
});
