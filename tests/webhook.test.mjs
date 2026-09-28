// tests/webhook.test.mjs
//
// Signature verification, payload parsing and Meta's message-shape limits.
//
// These are the three places where a subtle mistake is invisible in testing and
// catastrophic in production: a signature check that always passes, a payload
// shape that silently drops a customer's message, or a list with 11 rows that
// Meta rejects so the customer sees nothing at all.
//
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import { verifySignature, signBody, verifyTokenMatches } from "../utils/whatsapp/signature.js";
import { parseWebhookPayload, hasActionableContent } from "../utils/whatsapp/parser.js";
import {
  buildTextPayload,
  buildButtonsPayload,
  buildListPayload,
  buildReadReceiptPayload,
  truncate,
  LIMITS,
} from "../utils/whatsapp/client.js";

const SECRET = "meta-app-secret-for-tests";

/* ------------------------------------------------------------- signatures */

test("a correctly signed body verifies", () => {
  const body = Buffer.from(JSON.stringify({ entry: [{ id: "1" }] }), "utf8");
  const header = signBody(body, SECRET);
  assert.equal(verifySignature(body, header, SECRET).valid, true);
});

test("a tampered body does not verify", () => {
  const body = Buffer.from('{"amount":20}', "utf8");
  const header = signBody(body, SECRET);
  const tampered = Buffer.from('{"amount":99}', "utf8");
  const result = verifySignature(tampered, header, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("a signature made with another secret does not verify", () => {
  const body = Buffer.from("{}", "utf8");
  assert.equal(verifySignature(body, signBody(body, "other-secret"), SECRET).valid, false);
});

test("re-serialising the body breaks the signature — which is why the route uses express.raw", () => {
  // This is the bug the raw-body mount exists to prevent. Meta sends formatted
  // JSON; express.json() parses it and anything downstream that re-serialises
  // (our sanitisation middleware does) produces different BYTES for the same
  // data — so the HMAC no longer matches.
  const raw = Buffer.from('{\n  "entry": [\n    { "id": "1" }\n  ]\n}', "utf8");
  const header = signBody(raw, SECRET);
  assert.equal(verifySignature(raw, header, SECRET).valid, true, "the raw bytes verify");

  const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString())), "utf8");
  assert.notEqual(raw.toString(), reserialised.toString(), "whitespace differs");
  assert.equal(
    verifySignature(reserialised, header, SECRET).valid,
    false,
    "a re-serialised body can never verify"
  );
});

test("missing, malformed and unsupported signature headers are rejected with a reason", () => {
  const body = Buffer.from("{}", "utf8");
  assert.equal(verifySignature(body, null, SECRET).reason, "signature_header_missing");
  assert.equal(verifySignature(body, "sha256=nothex", SECRET).reason, "malformed_signature");
  assert.equal(verifySignature(body, "sha1=abc", SECRET).reason, "unsupported_signature_algorithm");
  assert.equal(verifySignature(body, `sha256=${"a".repeat(63)}`, SECRET).reason, "malformed_signature");
});

test("no app secret configured means nothing verifies — fail closed, never open", () => {
  const body = Buffer.from("{}", "utf8");
  const result = verifySignature(body, signBody(body, SECRET), null);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "app_secret_not_configured");
});

test("signature comparison is case-insensitive on the hex digest", () => {
  const body = Buffer.from("{}", "utf8");
  const header = signBody(body, SECRET).toUpperCase().replace("SHA256=", "sha256=");
  assert.equal(verifySignature(body, header, SECRET).valid, true);
});

test("an empty body is rejected rather than treated as valid", () => {
  assert.equal(verifySignature(null, "sha256=" + "a".repeat(64), SECRET).valid, false);
});

/* ------------------------------------------------------------ verify token */

test("the webhook verify token must match exactly", () => {
  assert.equal(verifyTokenMatches("abc123", "abc123"), true);
  assert.equal(verifyTokenMatches("abc123", "abc124"), false);
  assert.equal(verifyTokenMatches("abc", "abc123"), false, "a prefix must not pass");
  assert.equal(verifyTokenMatches("", "abc123"), false);
  assert.equal(verifyTokenMatches("abc123", null), false);
});

/* ------------------------------------------------------------ payload parsing */

const envelope = (value) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA_ID", changes: [{ field: "messages", value }] }],
});

const META = { display_phone_number: "2250718923194", phone_number_id: "PHONE_ID" };
const CONTACT = { profile: { name: "Saif" }, wa_id: "2250718923194" };

test("a text message is parsed with its sender, profile name and id", () => {
  const parsed = parseWebhookPayload(envelope({
    messaging_product: "whatsapp",
    metadata: META,
    contacts: [CONTACT],
    messages: [{ from: "2250718923194", id: "wamid.ABC", timestamp: "1790000000", type: "text", text: { body: "  Bonjour  " } }],
  }));
  assert.equal(parsed.messages.length, 1);
  const m = parsed.messages[0];
  assert.equal(m.type, "text");
  assert.equal(m.text, "Bonjour", "whitespace trimmed");
  assert.equal(m.from, "2250718923194");
  assert.equal(m.profileName, "Saif");
  assert.equal(m.waMessageId, "wamid.ABC");
  assert.equal(m.phoneNumberId, "PHONE_ID");
  assert.ok(m.timestamp instanceof Date);
});

test("a button reply is parsed as a selection carrying its id", () => {
  const parsed = parseWebhookPayload(envelope({
    metadata: META, contacts: [CONTACT],
    messages: [{
      from: "2250718923194", id: "wamid.B", type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "gender:Male", title: "Masculin" } },
    }],
  }));
  const m = parsed.messages[0];
  assert.equal(m.type, "selection");
  assert.equal(m.selectionId, "gender:Male");
  assert.equal(m.selectionTitle, "Masculin");
});

test("a list reply is parsed as a selection", () => {
  const parsed = parseWebhookPayload(envelope({
    metadata: META, contacts: [CONTACT],
    messages: [{
      from: "2250718923194", id: "wamid.L", type: "interactive",
      interactive: { type: "list_reply", list_reply: { id: "country:FR", title: "France" } },
    }],
  }));
  assert.equal(parsed.messages[0].selectionId, "country:FR");
});

test("a template button reply is parsed as a selection", () => {
  const parsed = parseWebhookPayload(envelope({
    metadata: META, contacts: [CONTACT],
    messages: [{ from: "2250718923194", id: "wamid.T", type: "button", button: { payload: "cmd:restart", text: "Recommencer" } }],
  }));
  assert.equal(parsed.messages[0].selectionId, "cmd:restart");
});

test("every media type is flagged unsupported with its kind, not dropped", () => {
  for (const kind of ["image", "video", "audio", "voice", "document", "sticker", "location", "contacts"]) {
    const parsed = parseWebhookPayload(envelope({
      metadata: META, contacts: [CONTACT],
      messages: [{ from: "2250718923194", id: `wamid.${kind}`, type: kind, [kind]: {} }],
    }));
    assert.equal(parsed.messages.length, 1, kind);
    assert.equal(parsed.messages[0].type, "unsupported", kind);
    assert.equal(parsed.messages[0].unsupportedKind, kind, kind);
  }
});

test("an unknown future message type does not throw and is treated as unsupported", () => {
  const parsed = parseWebhookPayload(envelope({
    metadata: META, contacts: [CONTACT],
    messages: [{ from: "2250718923194", id: "wamid.X", type: "some_new_meta_type", some_new_meta_type: {} }],
  }));
  assert.equal(parsed.messages[0].type, "unsupported");
});

test("a Flows (nfm) reply is treated as unsupported rather than mis-parsed", () => {
  const parsed = parseWebhookPayload(envelope({
    metadata: META, contacts: [CONTACT],
    messages: [{ from: "2250718923194", id: "wamid.N", type: "interactive", interactive: { type: "nfm_reply", nfm_reply: {} } }],
  }));
  assert.equal(parsed.messages[0].type, "unsupported");
});

test("delivery receipts are separated from messages", () => {
  const parsed = parseWebhookPayload(envelope({
    metadata: META,
    statuses: [
      { id: "wamid.OUT1", status: "delivered", timestamp: "1790000000", recipient_id: "2250718923194" },
      { id: "wamid.OUT2", status: "failed", timestamp: "1790000001", recipient_id: "2250718923194",
        errors: [{ code: 131047, title: "Re-engagement message" }] },
    ],
  }));
  assert.equal(parsed.messages.length, 0);
  assert.equal(parsed.statuses.length, 2);
  assert.equal(parsed.statuses[0].status, "delivered");
  assert.equal(parsed.statuses[1].errorCode, 131047);
  assert.equal(hasActionableContent(parsed), false);
});

test("several messages in one webhook batch are all returned", () => {
  const parsed = parseWebhookPayload({
    entry: [
      { changes: [{ value: { metadata: META, contacts: [CONTACT], messages: [{ from: "1", id: "a", type: "text", text: { body: "one" } }] } }] },
      { changes: [{ value: { metadata: META, contacts: [CONTACT], messages: [{ from: "2", id: "b", type: "text", text: { body: "two" } }] } }] },
    ],
  });
  assert.equal(parsed.messages.length, 2);
});

test("malformed and empty payloads return empty results instead of throwing", () => {
  for (const payload of [null, undefined, {}, { entry: null }, { entry: [{}] }, { entry: [{ changes: [{}] }] }, "not an object"]) {
    const parsed = parseWebhookPayload(payload);
    assert.equal(parsed.messages.length, 0);
    assert.equal(parsed.statuses.length, 0);
  }
});

/* ------------------------------------------------------- outbound payloads */

test("a text payload has the right shape and is clipped to Meta's limit", () => {
  const p = buildTextPayload("2250718923194", "Bonjour");
  assert.equal(p.messaging_product, "whatsapp");
  assert.equal(p.type, "text");
  assert.equal(p.text.body, "Bonjour");

  const long = buildTextPayload("225", "x".repeat(5000));
  assert.ok(long.text.body.length <= LIMITS.bodyText);
});

test("buttons are capped at three and titles at twenty characters", () => {
  const p = buildButtonsPayload("225", "Choose", [
    { id: "a", title: "A very long button title indeed" },
    { id: "b", title: "Two" },
    { id: "c", title: "Three" },
    { id: "d", title: "Four" },
  ]);
  assert.equal(p.interactive.action.buttons.length, LIMITS.buttonCount);
  for (const b of p.interactive.action.buttons) {
    assert.ok(b.reply.title.length <= LIMITS.buttonTitle, b.reply.title);
  }
  assert.equal(p.interactive.action.buttons[1].reply.id, "b");
});

test("a list never exceeds ten rows in total, across sections", () => {
  const rows = (n, prefix) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, title: `Row ${i}` }));
  const p = buildListPayload("225", "Pick", [
    { title: "First", rows: rows(8, "a") },
    { title: "Second", rows: rows(8, "b") },
  ]);
  const total = p.interactive.action.sections.reduce((n, s) => n + s.rows.length, 0);
  assert.equal(total, LIMITS.listRows);
});

test("list row titles and descriptions are clipped", () => {
  const p = buildListPayload("225", "Pick", [
    { rows: [{ id: "x", title: "A".repeat(50), description: "B".repeat(200) }] },
  ]);
  const row = p.interactive.action.sections[0].rows[0];
  assert.ok(row.title.length <= LIMITS.listRowTitle);
  assert.ok(row.description.length <= LIMITS.listRowDescription);
});

test("empty sections are dropped rather than sent as invalid", () => {
  const p = buildListPayload("225", "Pick", [{ title: "Empty", rows: [] }, { rows: [{ id: "a", title: "A" }] }]);
  assert.equal(p.interactive.action.sections.length, 1);
});

test("the read-receipt payload has the shape Meta expects", () => {
  const p = buildReadReceiptPayload("wamid.ABC");
  assert.deepEqual(p, { messaging_product: "whatsapp", status: "read", message_id: "wamid.ABC" });
});

test("truncation prefers a word boundary and marks the cut", () => {
  const out = truncate("Assurance voyage internationale complete", 20);
  assert.ok(out.length <= 20);
  assert.ok(out.endsWith("…"));
  assert.ok(!out.endsWith(" …"));
});

test("truncation leaves short strings untouched", () => {
  assert.equal(truncate("France", 24), "France");
});
