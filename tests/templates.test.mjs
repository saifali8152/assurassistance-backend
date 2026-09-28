// tests/templates.test.mjs
//
// Template messages are the only way to reach a customer outside Meta's
// 24-hour customer-service window. Getting the payload shape wrong fails at
// send time, hours after the code ran, in a notification nobody is watching —
// so the shape is pinned here.
//
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTemplatePayload,
  componentsFromBodyParams,
  withinCustomerServiceWindow,
} from "../utils/whatsapp/client.js";

test("a template payload matches Meta's expected shape", () => {
  const p = buildTemplatePayload("2250718923194", "payment_received", "fr");
  assert.equal(p.messaging_product, "whatsapp");
  assert.equal(p.type, "template");
  assert.equal(p.template.name, "payment_received");
  assert.deepEqual(p.template.language, { code: "fr" });
  assert.ok(!("components" in p.template), "no empty components array is sent");
});

test("body parameters are positional and in order", () => {
  const components = componentsFromBodyParams(["Saif", "QT-BF664C18", "39 USD"]);
  assert.equal(components.length, 1);
  assert.equal(components[0].type, "body");
  assert.deepEqual(
    components[0].parameters.map((x) => x.text),
    ["Saif", "QT-BF664C18", "39 USD"]
  );
  assert.ok(components[0].parameters.every((x) => x.type === "text"));
});

test("an over-long variable is clipped rather than rejected by Meta", () => {
  const [component] = componentsFromBodyParams(["x".repeat(2000)]);
  assert.ok(component.parameters[0].text.length <= 1024);
});

test("no body parameters means no components key", () => {
  assert.deepEqual(componentsFromBodyParams([]), []);
  const p = buildTemplatePayload("225", "t", "en", componentsFromBodyParams([]));
  assert.ok(!("components" in p.template));
});

test("the language code defaults to French and accepts a full locale", () => {
  assert.equal(buildTemplatePayload("225", "t").template.language.code, "fr");
  assert.equal(buildTemplatePayload("225", "t", "en_GB").template.language.code, "en_GB");
  assert.equal(buildTemplatePayload("225", "t", null).template.language.code, "fr");
});

test("the 24-hour window is computed from the last inbound message", () => {
  const now = new Date("2026-09-28T12:00:00Z");
  assert.equal(withinCustomerServiceWindow(new Date("2026-09-28T11:00:00Z"), { now }), true, "1h ago");
  assert.equal(withinCustomerServiceWindow(new Date("2026-09-27T13:00:00Z"), { now }), true, "23h ago");
  assert.equal(withinCustomerServiceWindow(new Date("2026-09-27T11:00:00Z"), { now }), false, "25h ago");
  assert.equal(withinCustomerServiceWindow(new Date("2026-09-27T12:00:00Z"), { now }), false, "exactly 24h is closed");
});

test("a missing or unparseable timestamp closes the window rather than assuming it is open", () => {
  assert.equal(withinCustomerServiceWindow(null), false);
  assert.equal(withinCustomerServiceWindow(undefined), false);
  assert.equal(withinCustomerServiceWindow("not a date"), false);
});

test("a stored date string is accepted, as MySQL returns it", () => {
  const now = new Date("2026-09-28T12:00:00Z");
  assert.equal(withinCustomerServiceWindow("2026-09-28T10:00:00Z", { now }), true);
});
