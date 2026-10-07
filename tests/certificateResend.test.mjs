// tests/certificateResend.test.mjs
//
// "Send me my attestation again."
//
// A customer who has paid and then lost the document should not need a human for
// it, and the words they use are "attestation" and "certificate" — not a command
// verb. Two risks worth testing: reading a legitimate ANSWER as this command,
// and sending the same billable document over and over because someone typed it
// four times.
//
// The engine has no side effects, so what it must produce here is the reply plus
// a `certificate_requested` event; the controller does the sending.
//
import test from "node:test";
import assert from "node:assert/strict";

import { processMessage, CERTIFICATE_RESEND_LIMIT } from "../utils/whatsapp/engine.js";
import { FLOW } from "../utils/whatsapp/flow.default.js";
import { detectCommand, detectCommandFromSelection, COMMANDS } from "../utils/whatsapp/commands.js";

/* ------------------------------------------------------------- recognition */

test("the words a customer actually uses are recognised", () => {
  for (const said of [
    "attestation",
    "Attestation",
    "ATTESTATION !",
    "mon attestation",
    "renvoyer mon attestation",
    "je veux mon attestation svp",
    "ou est mon attestation",
    "certificat",
    "mon certificat",
    "certificate",
    "my certificate",
    "resend my certificate",
    "i lost my certificate",
    "please send my certificate",
  ]) {
    assert.equal(detectCommand(said), COMMANDS.CERTIFICATE, `${said} should ask for the certificate`);
  }
});

test("an answer is not mistaken for the command", () => {
  // Each of these is something a customer could legitimately type at a prompt.
  for (const said of [
    "document",
    "police",
    "contrat",
    "Jean Attestation Kouassi est mon nom complet",
    "my certificate number is CERT-2026-000042",
    "attestation 12345",
  ]) {
    assert.notEqual(detectCommand(said), COMMANDS.CERTIFICATE, `${said} must not be read as a command`);
  }
});

test("the other commands still win over the loose reading", () => {
  assert.equal(detectCommand("aide"), COMMANDS.HELP);
  assert.equal(detectCommand("annuler"), COMMANDS.CANCEL);
  assert.equal(detectCommand("recommencer"), COMMANDS.RESTART);
  assert.equal(detectCommand("retour"), COMMANDS.BACK);
});

test("a button can ask for it too", () => {
  assert.equal(detectCommandFromSelection("cmd:certificate"), COMMANDS.CERTIFICATE);
});

/* ---------------------------------------------------------------- fixtures */

const POLICY = {
  sale_id: 900,
  case_id: 501,
  policy_number: "AA-2026-000042",
  certificate_id: 700,
  certificate_number: "CERT-2026-000042",
  public_token: "f".repeat(48),
  recent_sends: 0,
};

function makeCtx({ findIssuedPolicy = async () => POLICY } = {}) {
  return {
    flow: FLOW,
    now: new Date("2026-09-28T00:00:00Z"),
    payment: null,
    config: { defaultLanguage: "fr", maxFieldRetries: 3, escalationNumber: null },
    deps: {
      getCountries: async () => [],
      getDestinations: async () => [],
      getCountryByCode: async () => null,
      getPlans: async () => [],
      persistQuote: async () => ({ ok: false }),
      findIssuedPolicy,
    },
  };
}

const session = (over = {}) => ({
  id: 1,
  waNumber: "2250718923194",
  profileName: "Saif",
  language: "fr",
  currentStep: null,
  stepHistory: [],
  collectedData: {},
  retryCount: 0,
  status: "active",
  ...over,
});

const ask = (ctx, over = {}, text = "attestation") =>
  processMessage({
    message: { type: "text", text, from: "2250718923194", profileName: "Saif", rawType: "text", selectionId: null },
    session: session(over),
    ctx,
  });

const bodies = (r) => r.replies.map((x) => x.body).join("\n");
const certEvent = (r) => (r.events || []).find((e) => e.type === "certificate_requested");

/* ------------------------------------------------------------- the request */

test("an issued policy is answered with a word and a delivery request", async () => {
  const result = await ask(makeCtx());

  assert.match(bodies(result), /attestation/i);
  assert.match(bodies(result), /AA-2026-000042/, "the customer should see which policy is coming");

  const event = certEvent(result);
  assert.ok(event, "the controller is told to send the document");
  assert.equal(event.data.deliver, true);
  assert.equal(event.data.saleId, 900);
  assert.equal(event.data.policyNumber, "AA-2026-000042");
  assert.deepEqual(result.patch, {}, "asking for a document must not move the conversation");
});

test("nothing is sent when the number has no policy", async () => {
  const result = await ask(makeCtx({ findIssuedPolicy: async () => null }));

  assert.match(bodies(result), /CONSEILLER/, "the customer is pointed at a person");
  const event = certEvent(result);
  assert.equal(event.data.found, false);
  assert.notEqual(event.data.deliver, true, "there is nothing to deliver");
});

test("a policy whose certificate is missing says so instead of failing silently", async () => {
  const result = await ask(makeCtx({ findIssuedPolicy: async () => ({ ...POLICY, certificate_id: null }) }));

  assert.match(bodies(result), /AA-2026-000042/);
  const event = certEvent(result);
  assert.equal(event.data.ready, false);
  assert.notEqual(event.data.deliver, true);
});

test("a lookup failure reads as nothing found rather than an error", async () => {
  const result = await ask(makeCtx({
    findIssuedPolicy: async () => { throw new Error("database is down"); },
  }));

  assert.match(bodies(result), /CONSEILLER/);
  assert.notEqual(certEvent(result).data.deliver, true);
});

test("a missing dependency does not crash the conversation", async () => {
  const ctx = makeCtx();
  delete ctx.deps.findIssuedPolicy;
  const result = await ask(ctx);
  assert.ok(bodies(result).length > 0);
  assert.notEqual(certEvent(result).data.deliver, true);
});

/* ----------------------------------------------------------------- throttle */

test("asking repeatedly does not send a third copy", async () => {
  const result = await ask(makeCtx({
    findIssuedPolicy: async () => ({ ...POLICY, recent_sends: CERTIFICATE_RESEND_LIMIT }),
  }));

  assert.match(bodies(result), /au-dessus/, "the customer is told to look up the conversation");
  const event = certEvent(result);
  assert.equal(event.data.throttled, true);
  assert.notEqual(event.data.deliver, true);
});

test("one previous send is still under the limit", async () => {
  const result = await ask(makeCtx({
    findIssuedPolicy: async () => ({ ...POLICY, recent_sends: CERTIFICATE_RESEND_LIMIT - 1 }),
  }));
  assert.equal(certEvent(result).data.deliver, true);
});

/* -------------------------------------------------------------- mid-flow */

test("asking mid-flow sends the document without re-asking the question", async () => {
  const result = await ask(makeCtx(), { currentStep: "email", collectedData: { first_name: "Saif" } });

  assert.equal(result.replies.length, 1, "a prompt printed above an arriving document reads as being ignored");
  assert.equal(certEvent(result).data.deliver, true);
  assert.deepEqual(result.patch, {}, "the customer stays exactly where they were");
});

test("when there is nothing to send, the question is asked again", async () => {
  const result = await ask(
    makeCtx({ findIssuedPolicy: async () => null }),
    { currentStep: "email", collectedData: { first_name: "Saif" } }
  );

  assert.ok(result.replies.length >= 2, "the conversation has to carry on");
  assert.match(bodies(result), /e-?mail/i);
});

/* -------------------------------------------------------------- languages */

test("an English conversation is answered in English", async () => {
  const result = await ask(makeCtx(), { language: "en" }, "my certificate");
  assert.match(bodies(result), /certificate/i);
  assert.doesNotMatch(bodies(result), /attestation/i);
  assert.equal(certEvent(result).data.deliver, true);
});

test("the English wording points at AGENT, not CONSEILLER", async () => {
  const result = await ask(
    makeCtx({ findIssuedPolicy: async () => null }),
    { language: "en" },
    "resend my certificate"
  );
  assert.match(bodies(result), /AGENT/);
});

test("the help text tells the customer the command exists, in both languages", async () => {
  const fr = await ask(makeCtx(), {}, "aide");
  assert.match(bodies(fr), /ATTESTATION/);
  const en = await ask(makeCtx(), { language: "en" }, "help");
  assert.match(bodies(en), /CERTIFICATE/);
});
