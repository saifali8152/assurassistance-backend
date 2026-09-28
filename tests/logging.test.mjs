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
import { logger, requestIdMiddleware } from "../utils/logger.js";

function capture(fn) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (s) => lines.push(String(s));
  try {
    fn();
  } finally {
    Object.assign(console, original);
  }
  return lines.join("\n");
}

test("secrets never reach the log output", () => {
  const out = capture(() =>
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

test("ordinary fields are untouched", () => {
  const out = capture(() => logger.info({ waNumber: "2250718923194", step: "email" }, "step advanced"));
  assert.ok(out.includes("2250718923194"));
  assert.ok(out.includes("email"));
});

test("arrays and deep structures are walked", () => {
  const out = capture(() => logger.warn({ keys: [{ secret: "s1" }, { secret: "s2" }] }, "batch"));
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
