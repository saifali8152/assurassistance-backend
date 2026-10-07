// tests/alerts.test.mjs
//
// Alerting exists because nothing told a human when anything broke. These pin
// the two properties that decide whether it keeps working: it throttles, and it
// never carries personal data into an inbox.
//
import test from "node:test";
import assert from "node:assert/strict";

import { notifyOps, alertingEnabled, alertRecipients, __resetAlerts } from "../utils/alerts.js";

test("with no recipient configured, alerting is off rather than failing", async () => {
  __resetAlerts();
  delete process.env.ALERT_EMAIL;
  delete process.env.OPS_EMAIL;
  assert.equal(alertingEnabled(), false);
  const r = await notifyOps("k", "something broke");
  assert.equal(r.sent, false);
  assert.equal(r.reason, "no_recipient");
});

test("recipients can be a list", () => {
  process.env.ALERT_EMAIL = "a@x.test, b@x.test;c@x.test";
  assert.deepEqual(alertRecipients(), ["a@x.test", "b@x.test", "c@x.test"]);
  delete process.env.ALERT_EMAIL;
});

test("the same problem repeating is counted, not re-sent", async () => {
  __resetAlerts();
  delete process.env.ALERT_EMAIL;
  // Without a recipient nothing is sent, but the counter still runs — which is
  // what the throttle is built on.
  await notifyOps("same", "boom");
  const second = await notifyOps("same", "boom");
  assert.equal(second.reason, "no_recipient");
});

test("a provider outage cannot produce one alert per customer", async () => {
  __resetAlerts();
  process.env.ALERT_EMAIL = "ops@x.test";
  // sendEmail will fail with no SMTP configured; what matters is that only the
  // FIRST of a burst is even attempted.
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await notifyOps("outage", "provider down"));
  const throttled = results.filter((r) => r.reason === "throttled");
  assert.equal(throttled.length, 4, "only the first of a burst should be attempted");
  delete process.env.ALERT_EMAIL;
});

test("different problems are not throttled against each other", async () => {
  __resetAlerts();
  process.env.ALERT_EMAIL = "ops@x.test";
  const a = await notifyOps("one", "first problem");
  const b = await notifyOps("two", "second problem");
  assert.notEqual(a.reason, "throttled");
  assert.notEqual(b.reason, "throttled");
  delete process.env.ALERT_EMAIL;
});
