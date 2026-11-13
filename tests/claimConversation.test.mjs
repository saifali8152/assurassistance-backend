// tests/claimConversation.test.mjs
//
// Milestone 4, Days 3–4 — the claim conversation, end to end, in memory.
//
// Same approach as conversation.test.mjs: the engine returns replies and a
// session patch, so the whole journey is driven message by message with no
// Meta, no webhook and no database. The database side (checking the policy,
// saving the draft, submitting) is faked here and tested for real in the
// integration suites.
//
// The purchase tests in conversation.test.mjs run with claims absent from the
// context, which is exactly production while the switch is off.
//
import test from "node:test";
import assert from "node:assert/strict";

import { processMessage } from "../utils/whatsapp/engine.js";
import { FLOW } from "../utils/whatsapp/flow.default.js";
import { DEFAULT_CATEGORIES } from "../utils/claims/defaultCategories.js";
import { mapCategory } from "../models/claimCategoryModel.js";
import { translator } from "../utils/i18n.js";

const tFr = translator("fr");
const tEn = translator("en");

/* ---------------------------------------------------------------- fixtures */

const COUNTRIES = [
  { code: "FR", name_en: "France", name_fr: "France", zone: "Worldwide", active: true },
  { code: "CI", name_en: "Côte-d'Ivoire", name_fr: "Côte-d'Ivoire", zone: "Worldwide", active: true },
  { code: "SN", name_en: "Senegal", name_fr: "Sénégal", zone: "Worldwide", active: true },
  { code: "MA", name_en: "Morocco", name_fr: "Maroc", zone: "Worldwide", active: true },
  { code: "ES", name_en: "Spain", name_fr: "Espagne", zone: "Worldwide", active: true },
];

const ALL = DEFAULT_CATEGORIES.map((c, i) => mapCategory({ ...c, id: i + 1, active: 1 }));
const TREE = ALL.filter((c) => !c.parentCode).map((p) => ({ ...p, children: ALL.filter((c) => c.parentCode === p.code) }));
const SUBS = ALL.filter((c) => c.parentCode);

const POLICY = {
  source: "sale", saleId: 441, externalPolicyId: null, policyNumber: "AA-2026-000441",
  holderFirstName: "AWA", planName: "Agico Retail", startDate: "2026-09-01", endDate: "2026-12-31",
  guaranteeCodes: null, isTest: false, flags: [],
};

const PLAN = {
  id: 11, name: "Agico Retail", product_type: "Travel", currency: "XOF",
  pricing_rules: { pricingColumns: ["Worldwide"], pricing: [{ label: "10 Days", columns: { Worldwide: 20 } }] },
  coverage_summary_fr: "Frais médicaux", coverage_summary_en: "Medical", flat_price: null, fixed_duration_premiums: 0,
};

function makeCtx({ access = { enabled: true, allowlisted: false, allowed: true }, config = {}, validate = null, policy = POLICY,
  submit = null, resumable = null, tracked = null, tree = TREE, escalationNumber = "+225 07 00 00 00" } = {}) {
  const calls = { validate: [], create: [], save: [], abandon: [], submit: [], track: [] };
  let nextId = 900;
  const claimsConfig = {
    cardNumberMode: "certificate", expiryRule: "incident_date", filingWindowDays: null, unpaidPolicies: "allow_flag",
    uncoveredClaimType: "flag", descriptionMin: 20, descriptionMax: 1500, lockoutMinutes: 30,
    urgentKeywords: { fr: ["urgence", "hôpital"], en: ["emergency", "hospital"] },
    consentText: { fr: "", en: "" }, confirmationText: { fr: "", en: "" },
    ...config,
  };
  const ctx = {
    flow: FLOW,
    now: new Date("2026-11-13T10:00:00Z"),
    config: { defaultLanguage: "fr", maxFieldRetries: 3, escalationNumber },
    payment: null,
    deps: {
      getCountries: async () => COUNTRIES,
      getDestinations: async () => COUNTRIES,
      getCountryByCode: async (code) => COUNTRIES.find((c) => c.code === code) || null,
      getPlans: async () => [PLAN],
      persistQuote: async () => ({ ok: true, quoteReference: "QT-1", caseId: 1, travellerId: 1 }),
      startPayment: async () => ({ ok: true, transactionId: 1, reference: "PAY-1", amountText: "20 FCFA" }),
    },
    claims: {
      access,
      config: claimsConfig,
      getCategoryTree: async () => tree,
      deps: {
        validatePolicy: async (args) => {
          calls.validate.push(args);
          if (validate) return validate(args, calls.validate.length);
          return args.passport.toUpperCase() === "AB123456"
            ? { ok: true, session: policy, flags: [] }
            : { ok: false, outcome: "not_found", attemptsLeft: 3 - calls.validate.length };
        },
        createDraft: async (args) => { calls.create.push(args); nextId += 1; return nextId; },
        saveDraft: async (id, patch) => { calls.save.push({ id, patch }); },
        abandonDraft: async (id, reason) => { calls.abandon.push({ id, reason }); },
        submitClaim: async (args) => {
          calls.submit.push(args);
          return submit ? submit(args) : { ok: true, reference: "SIN-2026-000001" };
        },
        trackClaim: async (args) => { calls.track.push(args); return tracked ? tracked(args) : null; },
        findResumableDraft: async () => resumable,
      },
    },
  };
  return { ctx, calls };
}

function conversation(options = {}) {
  const { ctx, calls } = makeCtx(options);
  let session = {
    id: 7, waNumber: "2250718923194", profileName: "Awa", language: "fr", currentStep: null, stepHistory: [],
    collectedData: {}, retryCount: 0, status: "active", claimId: null, parkedPurchase: null, ...(options.session || {}),
  };
  const events = [];
  const send = async (input) => {
    const message = typeof input === "string"
      ? { type: "text", text: input, from: session.waNumber, profileName: "Awa", rawType: "text", selectionId: null }
      : { from: session.waNumber, profileName: "Awa", ...input };
    const result = await processMessage({ message, session, ctx });
    session = { ...session, ...(result.patch || {}) };
    events.push(...(result.events || []));
    return result;
  };
  const tap = (id) => send({ type: "selection", selectionId: id, selectionTitle: id, rawType: "interactive", text: null });
  return {
    send, tap, ctx, calls, events,
    get session() { return session; },
    get step() { return session.currentStep; },
    get state() { return session.collectedData?.__claim || {}; },
    set(patch) { session = { ...session, ...patch }; },
  };
}

const bodies = (r) => r.replies.map((x) => x.body).join("\n");
const last = (r) => r.replies[r.replies.length - 1];
const rowIds = (reply) => (reply.sections || []).flatMap((s) => s.rows.map((r) => r.id));
const buttonIds = (reply) => (reply.buttons || []).map((b) => b.id);

/** Answer one extra field the way a customer would. */
async function answerField(c, field) {
  if (field.type === "choice") return c.tap(`opt:${field.options[0].value}`);
  if (field.type === "number") return c.send(String(field.min ?? 2));
  if (field.type === "date") return c.send("02/11/2026");
  // Stay within the field's own limit (flight_number allows 12 characters).
  return c.send("Réponse de test".slice(0, Number(field.max_length) || 200));
}

/** From nothing to the category list. */
async function identify(c) {
  await c.send("Bonjour");
  await c.tap("menu:claim");
  await c.send("AA-2026-000441");
  await c.send("AB123456");
  await c.tap("claim:policy_yes");
}

/** Category → review, for one sub-category, answering everything. */
async function fillClaim(c, sub, { description = "Mon vol a eu six heures de retard à l'arrivée." } = {}) {
  await c.tap(`cat:${sub.parentCode}`);
  await c.tap(`sub:${sub.code}`);
  await c.send("05/11/2026");
  await c.send("France");
  await c.send("Paris");
  for (const f of sub.extraFields || []) await answerField(c, f);
  await c.send(description);
  if ((sub.requiredDocuments || []).length || (sub.optionalDocuments || []).length) {
    const r = await c.send("TERMINÉ");
    if (c.step === "claim_documents") await c.tap("claim:docs_later");
    return r;
  }
  return null;
}

/* ---------------------------------------------------------- the switch */

test("switch off: the menu is the same three buttons as before", async () => {
  const c = conversation({ access: { enabled: false, allowlisted: false, allowed: false } });
  const r = await c.send("Bonjour");
  assert.equal(r.replies[0].kind, "buttons");
  assert.deepEqual(buttonIds(r.replies[0]), ["menu:buy", "menu:question", "cmd:agent"]);
  assert.ok(!bodies(r).includes(tFr("welcome.optionClaim")));
});

test("switch off: the keyword, the track command and a stale menu row all get the neutral answer", async () => {
  const c = conversation({ access: { enabled: false, allowlisted: false, allowed: false } });
  await c.send("Bonjour");
  for (const r of [await c.send("je veux déclarer un sinistre"), await c.send("SUIVI SIN-2026-000001"), await c.tap("menu:claim")]) {
    assert.match(bodies(r), /bientôt disponible/);
    assert.equal(c.step, "welcome", "the customer stays where they were");
  }
  assert.equal(c.calls.validate.length, 0);
  assert.equal(c.calls.track.length, 0, "nothing is looked up while claims are off");
});

test("switch off with no context at all (the M2/M3 shape) behaves the same", async () => {
  const c = conversation();
  delete c.ctx.claims;
  const r = await c.send("sinistre");
  assert.match(bodies(r), /bientôt disponible/);
});

test("switch on: the menu becomes a list of five, within WhatsApp's limits", async () => {
  const c = conversation();
  const r = await c.send("Bonjour");
  const menu = r.replies[0];
  assert.equal(menu.kind, "list");
  assert.deepEqual(rowIds(menu), ["menu:buy", "menu:claim", "menu:track", "menu:question", "cmd:agent"]);
  for (const t of [tFr, tEn]) {
    for (const k of ["optionBuy", "optionClaim", "optionTrack", "optionQuestion", "optionAgent"]) assert.ok(t(`welcome.${k}`).length <= 24, k);
    for (const k of ["hintBuy", "hintClaim", "hintTrack", "hintQuestion", "hintAgent"]) assert.ok(t(`welcome.${k}`).length <= 72, k);
  }
  assert.match(menu.body, /sinistre/, "the greeting says claims exist");
});

test("switch on: buying from the new menu is the same purchase as before", async () => {
  const c = conversation();
  await c.send("Bonjour");
  const r = await c.tap("menu:buy");
  assert.equal(c.step, "identity");
  assert.match(bodies(r), new RegExp(tFr("step.personalInfo.prompt").slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("turned off in the middle of a claim: the customer is told, the draft is abandoned", async () => {
  const c = conversation();
  await identify(c);
  c.ctx.claims.access = { enabled: false, allowlisted: false, allowed: false };
  const r = await c.tap("cat:travel");
  assert.match(bodies(r), /bientôt disponible/);
  assert.equal(c.calls.abandon.at(-1).reason, "claims_disabled");
  assert.equal(c.step, "claim_closed");
});

/* ------------------------------------------------------ identification */

test("identification: policy number, passport, confirmation — then the draft exists", async () => {
  const c = conversation();
  await c.send("Bonjour");
  let r = await c.tap("menu:claim");
  assert.equal(c.step, "claim_identify");
  assert.match(bodies(r), /numéro de police/);
  r = await c.send("aa-2026-000441");
  assert.equal(c.step, "claim_passport");
  r = await c.send("ab123456");
  assert.equal(c.step, "claim_policy_confirm");
  assert.match(bodies(r), /AA-2026-000441/);
  assert.equal(c.calls.validate[0].identifier, "AA-2026-000441");
  assert.equal(c.calls.create.length, 0, "no draft before the customer confirms the policy");
  r = await c.tap("claim:policy_yes");
  assert.equal(c.step, "claim_category");
  assert.equal(c.calls.create.length, 1);
  assert.equal(c.session.claimId, 901);
  assert.equal(c.state.identifier, undefined, "the typed number is not kept once it has served");
  assert.ok(!JSON.stringify(c.session).includes("AB123456"), "the passport never sits in the session");
});

test("identification: a wrong passport says the same thing as an unknown number, and counts down", async () => {
  const c = conversation();
  await c.send("Bonjour");
  await c.tap("menu:claim");
  await c.send("AA-2026-000441");
  let r = await c.send("ZZ999");
  assert.match(bodies(r), /Essais restants : 2/);
  assert.equal(c.step, "claim_identify");
  await c.send("AA-2026-000441");
  r = await c.send("ZZ998");
  assert.match(bodies(r), /Essais restants : 1/);
  await c.send("AA-2026-000441");
  r = await c.send("ZZ997");
  assert.match(bodies(r), /suspendue pendant 30 minutes/);
  assert.equal(c.step, "claim_closed");
});

test("identification: a locked number is told how long to wait", async () => {
  const c = conversation({ validate: () => ({ ok: false, outcome: "locked", retryAfterMinutes: 12 }) });
  await c.send("Bonjour");
  await c.tap("menu:claim");
  await c.send("AA-2026-000441");
  const r = await c.send("AB123456");
  assert.match(bodies(r), /12 minutes/);
  assert.match(bodies(r), /\+225 07 00 00 00/);
});

test("identification: an expired policy explains and offers one tap to buy — which starts a purchase", async () => {
  const c = conversation({ validate: () => ({ ok: false, outcome: "expired", endDate: "2026-09-30", policy: POLICY }) });
  await c.send("Bonjour");
  await c.tap("menu:claim");
  await c.send("AA-2026-000441");
  const r = await c.send("AB123456");
  assert.match(bodies(r), /a pris fin le 30 septembre 2026/);
  const offer = r.replies.find((x) => x.kind === "buttons");
  assert.deepEqual(buttonIds(offer), ["menu:buy", "cmd:agent"]);
  await c.tap("menu:buy");
  assert.equal(c.step, "identity");
  assert.equal(c.session.flowKey, "purchase");
});

test("identification: a cancelled policy explains and flags an adviser", async () => {
  const c = conversation({ validate: () => ({ ok: false, outcome: "cancelled", policy: POLICY }) });
  await c.send("Bonjour");
  await c.tap("menu:claim");
  await c.send("AA-2026-000441");
  const r = await c.send("AB123456");
  assert.match(bodies(r), /annulée/);
  assert.ok(c.events.some((e) => e.type === "claim_agent_flag" && e.data.reason === "cancelled_policy"));
});

test("identification: 'no, another policy' goes back to the policy number", async () => {
  const c = conversation();
  await c.send("Bonjour");
  await c.tap("menu:claim");
  await c.send("AA-2026-000441");
  await c.send("AB123456");
  await c.tap("claim:policy_no");
  assert.equal(c.step, "claim_identify");
  assert.equal(c.calls.create.length, 0);
});

test("identification: nonsense instead of a policy number is refused before any lookup", async () => {
  const c = conversation();
  await c.send("Bonjour");
  await c.tap("menu:claim");
  const r = await c.send("je ne sais pas");
  assert.match(bodies(r), /ne semble pas valide/);
  assert.equal(c.calls.validate.length, 0);
});

/* --------------------------------------------- every sub-category, end to end */

for (const sub of SUBS) {
  test(`end to end: ${sub.parentCode} › ${sub.code}`, async () => {
    const c = conversation();
    await identify(c);
    await fillClaim(c, sub);
    assert.equal(c.step, "claim_review", `${sub.code} reaches the review`);
    const st = c.state;
    assert.equal(st.subcategory.code, sub.code);
    assert.equal(st.incidentDate, "2026-11-05");
    assert.equal(st.countryCode, "FR");
    assert.equal(st.city, "Paris");
    for (const f of sub.extraFields || []) assert.ok(f.key in st.fields, `${sub.code}.${f.key} answered`);
    assert.equal(st.priority, sub.defaultPriority, "priority from the sub-category");

    const r = await c.tap("claim:submit");
    assert.match(bodies(r), /SIN-2026-000001/);
    assert.equal(c.calls.submit.length, 1);
    assert.equal(c.calls.submit[0].claimId, 901);
    assert.equal(c.step, "claim_closed");
    // The draft was kept up to date along the way.
    assert.equal(c.calls.save.at(-1).patch.subcategoryCode, sub.code);
  });
}

/* ------------------------------------------------------- the incident */

test("incident date: in the future, unreadable, and outside cover are each explained", async () => {
  const c = conversation();
  await identify(c);
  await c.tap("cat:travel");
  await c.tap("sub:flight_delay");
  let r = await c.send("20/11/2026");
  assert.match(bodies(r), /dans le futur/);
  r = await c.send("le mois dernier");
  assert.match(bodies(r), /JJ\/MM\/AAAA/);
  r = await c.send("15/08/2026");
  assert.match(bodies(r), /du 1 septembre 2026 au 31 décembre 2026|01 septembre 2026/);
  assert.deepEqual(buttonIds(last(r)), ["menu:buy", "cmd:agent"]);
  assert.equal(c.step, "claim_incident_date", "a mistyped date can simply be sent again");
  await c.send("05/11/2026");
  assert.equal(c.step, "claim_country");
});

test("incident date: the filing window is applied when set", async () => {
  const c = conversation({ config: { filingWindowDays: 30 } });
  await identify(c);
  await c.tap("cat:travel");
  await c.tap("sub:flight_delay");
  const r = await c.send("02/09/2026");
  assert.match(bodies(r), /plus de 30 jours/);
  assert.equal(c.step, "claim_incident_date");
});

test("country: typed loosely, offered as a list when ambiguous", async () => {
  const c = conversation();
  await identify(c);
  await c.tap("cat:travel");
  await c.tap("sub:theft");
  await c.send("05/11/2026");
  await c.send("Sénégal");
  assert.equal(c.state.countryCode, "SN");
  assert.equal(c.state.countryLabel, "Sénégal");
  assert.equal(c.step, "claim_city");
});

test("extra fields: numbers are range-checked, choices read typed labels, optional ones can be skipped", async () => {
  const c = conversation();
  await identify(c);
  await c.tap("cat:travel");
  await c.tap("sub:flight_delay");
  await c.send("05/11/2026");
  await c.send("France");
  await c.send("Paris");
  const fields = SUBS.find((s) => s.code === "flight_delay").extraFields;
  for (const f of fields) {
    if (f.type === "number") {
      let r = await c.send("beaucoup");
      assert.match(bodies(r), /nombre/);
      if (f.max !== undefined) {
        r = await c.send(String(f.max + 1000));
        assert.match(bodies(r), /entre/);
      }
      await c.send(String(f.min ?? 3));
    } else if (!f.required) {
      await c.send("PASSER");
      assert.equal(c.state.fields[f.key], null);
    } else {
      await answerField(c, f);
    }
  }
  assert.equal(c.step, "claim_description");
});

test("description: length is guided both ways", async () => {
  const c = conversation({ config: { descriptionMin: 20, descriptionMax: 60 } });
  await identify(c);
  await c.tap("cat:legal");
  await c.tap("sub:legal_assistance");
  await c.send("05/11/2026");
  await c.send("France");
  await c.send("Paris");
  for (const f of SUBS.find((s) => s.code === "legal_assistance").extraFields) await answerField(c, f);
  let r = await c.send("trop court");
  assert.match(bodies(r), /au moins 20/);
  r = await c.send("x".repeat(80));
  assert.match(bodies(r), /80 caractères, 60 au maximum/);
});

test("description: an urgent word raises the priority and gives the adviser's number", async () => {
  const c = conversation();
  await identify(c);
  const sub = SUBS.find((s) => s.code === "theft");
  await c.tap("cat:travel");
  await c.tap("sub:theft");
  await c.send("05/11/2026");
  await c.send("France");
  await c.send("Paris");
  for (const f of sub.extraFields) await answerField(c, f);
  const r = await c.send("C'est une URGENCE, on m'a tout volé y compris mes médicaments.");
  assert.match(bodies(r), /urgente/);
  assert.match(bodies(r), /\+225 07 00 00 00/);
  assert.equal(c.state.priority, "urgent");
  assert.ok(c.state.flags.includes("urgent_keywords"));
  assert.ok(c.events.some((e) => e.type === "claim_urgent_detected"));
});

test("description: a sentence mentioning the certificate is a description, not a command", async () => {
  const c = conversation();
  await identify(c);
  const sub = SUBS.find((s) => s.code === "travel_document_loss");
  await c.tap("cat:travel");
  await c.tap("sub:travel_document_loss");
  await c.send("05/11/2026");
  await c.send("France");
  await c.send("Paris");
  for (const f of sub.extraFields) await answerField(c, f);
  await c.send("J'ai perdu mon passeport et mon attestation dans le métro.");
  assert.equal(c.state.description, "J'ai perdu mon passeport et mon attestation dans le métro.");
});

/* -------------------------------------------------------- coverage */

test("coverage: a claim type the plan lacks is flagged by default", async () => {
  const c = conversation({ policy: { ...POLICY, guaranteeCodes: ["medicalEmergencies"] } });
  await identify(c);
  await c.tap("cat:travel");
  await c.tap("sub:trip_cancellation");
  assert.ok(c.state.flags.includes("uncovered_claim_type"));
  assert.equal(c.step, "claim_incident_date");
});

test("coverage: refused when the client says so — back to the categories, nothing kept", async () => {
  const c = conversation({ policy: { ...POLICY, guaranteeCodes: ["medicalEmergencies"] }, config: { uncoveredClaimType: "refuse" } });
  await identify(c);
  await c.tap("cat:travel");
  const r = await c.tap("sub:trip_cancellation");
  assert.match(bodies(r), /ne comprend pas cette garantie/);
  assert.equal(c.step, "claim_category");
  assert.equal(c.state.subcategory, undefined);
});

/* ------------------------------------------------ documents (step only) */

test("documents: TERMINÉ with required files missing asks, PLUS TARD continues and flags it", async () => {
  const c = conversation();
  await identify(c);
  const sub = SUBS.find((s) => s.code === "flight_delay");
  await c.tap("cat:travel");
  await c.tap("sub:flight_delay");
  await c.send("05/11/2026");
  await c.send("France");
  await c.send("Paris");
  for (const f of sub.extraFields) await answerField(c, f);
  let r = await c.send("Mon vol a eu six heures de retard à l'arrivée.");
  assert.equal(c.step, "claim_documents");
  assert.match(bodies(r), /Obligatoires/);
  r = await c.send("TERMINÉ");
  assert.match(bodies(r), /Il manque encore/);
  assert.equal(c.step, "claim_documents");
  await c.send("plus tard");
  assert.equal(c.step, "claim_review");
  assert.ok(c.state.flags.includes("documents_incomplete"));
});

/* ------------------------------------------------ review, edit, consent */

async function toReview(c, code = "theft") {
  await identify(c);
  await fillClaim(c, SUBS.find((s) => s.code === code));
  assert.equal(c.step, "claim_review");
}

test("review: shows every answer, and editing the date comes straight back to it", async () => {
  const c = conversation();
  await toReview(c);
  let r = await c.send("Modifier");
  assert.equal(c.step, "claim_edit");
  r = await c.tap("edit:date");
  assert.equal(c.step, "claim_incident_date");
  r = await c.send("06/11/2026");
  assert.equal(c.step, "claim_review");
  assert.match(bodies(r), /C'est modifié/);
  assert.match(bodies(r), /6 novembre 2026|06 novembre 2026/);
});

test("review: changing the claim type asks the new type's questions, then returns", async () => {
  const c = conversation();
  await toReview(c, "theft");
  await c.tap("claim:modify");
  await c.tap("edit:type");
  await c.tap("cat:travel");
  await c.tap("sub:flight_delay");
  const fd = SUBS.find((s) => s.code === "flight_delay");
  assert.equal(c.step, "claim_field:0", "the new sub-category's questions");
  for (const f of fd.extraFields) await answerField(c, f);
  assert.equal(c.step, "claim_review");
  assert.deepEqual(Object.keys(c.state.fields).sort(), fd.extraFields.map((f) => f.key).sort(), "old answers cleared");
});

test("review: changing the place walks country then city, then returns", async () => {
  const c = conversation();
  await toReview(c);
  await c.tap("claim:modify");
  await c.tap("edit:place");
  await c.send("Maroc");
  assert.equal(c.step, "claim_city");
  await c.send("Rabat");
  assert.equal(c.step, "claim_review");
  assert.equal(c.state.countryCode, "MA");
});

test("consent: asked only when the client has written it; declining keeps the claim", async () => {
  const c = conversation({ config: { consentText: { fr: "J'autorise le traitement de mes données.", en: "I agree." } } });
  await toReview(c);
  let r = await c.tap("claim:submit");
  assert.equal(c.step, "claim_consent");
  assert.match(bodies(r), /J'autorise le traitement/);
  r = await c.tap("claim:consent_no");
  assert.equal(c.step, "claim_review");
  assert.equal(c.calls.submit.length, 0);
  await c.tap("claim:submit");
  r = await c.tap("claim:consent_yes");
  assert.equal(c.calls.submit.length, 1);
  assert.ok(c.calls.submit[0].state.consentAcceptedAt);
});

test("no consent text: submitting goes straight through", async () => {
  const c = conversation();
  await toReview(c);
  await c.tap("claim:submit");
  assert.equal(c.calls.submit.length, 1);
});

test("the client's own confirmation text is used, with the reference filled in", async () => {
  const c = conversation({ config: { confirmationText: { fr: "Merci ! Dossier {{reference}} reçu.", en: "" } } });
  await toReview(c);
  const r = await c.tap("claim:submit");
  assert.match(bodies(r), /Merci ! Dossier SIN-2026-000001 reçu\./);
});

test("a failed submission loses nothing: still at the review, with an explanation", async () => {
  const c = conversation({ submit: () => ({ ok: false, reason: "db_down" }) });
  await toReview(c);
  const r = await c.tap("claim:submit");
  assert.match(bodies(r), /n'a pas pu être enregistrée/);
  assert.equal(c.step, "claim_review");
  assert.equal(c.state.city, "Paris");
});

/* --------------------------------------------- back, restart, cancel */

test("BACK walks back through the claim, never into identification once the draft exists", async () => {
  const c = conversation();
  await identify(c);
  let r = await c.send("RETOUR");
  assert.match(bodies(r), /au début de la déclaration/);
  assert.equal(c.step, "claim_category");
  await c.tap("cat:travel");
  await c.tap("sub:theft");
  await c.send("05/11/2026");
  await c.send("France");
  r = await c.send("retour");
  assert.equal(c.step, "claim_country");
  r = await c.send("retour");
  assert.equal(c.step, "claim_incident_date");
});

test("BACK through the extra questions one at a time", async () => {
  const c = conversation();
  await identify(c);
  await c.tap("cat:travel");
  await c.tap("sub:flight_delay");
  await c.send("05/11/2026");
  await c.send("France");
  await c.send("Paris");
  const fields = SUBS.find((s) => s.code === "flight_delay").extraFields;
  await answerField(c, fields[0]);
  assert.equal(c.step, "claim_field:1");
  await c.send("RETOUR");
  assert.equal(c.step, "claim_field:0");
});

test("RESTART restarts the claim only: draft abandoned, back to the policy number", async () => {
  const c = conversation();
  await identify(c);
  await c.tap("cat:travel");
  const r = await c.send("RECOMMENCER");
  assert.match(bodies(r), /depuis le début/);
  assert.equal(c.step, "claim_identify");
  assert.deepEqual(c.calls.abandon.at(-1), { id: 901, reason: "restarted_by_customer" });
  assert.equal(c.session.claimId, null);
});

test("CANCEL abandons the draft and says nothing was sent", async () => {
  const c = conversation();
  await toReview(c);
  const r = await c.tap("claim:cancel");
  assert.match(bodies(r), /Rien n'a été transmis/);
  assert.equal(c.calls.abandon.at(-1).reason, "cancelled_by_customer");
  assert.equal(c.step, "claim_closed");
  const next = await c.send("Bonjour");
  assert.equal(next.replies[0].kind, "list", "the next message opens the main menu");
  assert.equal(c.step, "welcome");
});

/* ------------------------------------------------- isolation (D7) */

async function purchaseToEmail(c) {
  await c.send("Bonjour");
  await c.tap("menu:buy");
  await c.send("Ali, Saif, 12/03/1990, AB1234567");
  await c.tap("gender:Male");
  await c.send("France");
  assert.equal(c.step, "destination_dates");
}

test("mid-purchase: a claim request asks first; 'no' puts the purchase back exactly", async () => {
  const c = conversation();
  await purchaseToEmail(c);
  const before = JSON.stringify({ step: c.step, data: c.session.collectedData, history: c.session.stepHistory });
  let r = await c.send("sinistre");
  assert.equal(c.step, "claim_switch_confirm");
  assert.match(bodies(r), /devis en cours/);
  r = await c.tap("claim:switch_no");
  assert.equal(JSON.stringify({ step: c.step, data: c.session.collectedData, history: c.session.stepHistory }), before);
  assert.equal(c.session.parkedPurchase, null);
});

test("mid-purchase: 'yes' parks the purchase, and it comes back after the claim is sent", async () => {
  const c = conversation();
  await purchaseToEmail(c);
  const data = JSON.stringify(c.session.collectedData);
  await c.send("sinistre");
  await c.tap("claim:switch_yes");
  assert.equal(c.step, "claim_identify");
  assert.ok(c.session.parkedPurchase);
  assert.ok(!("last_name" in c.session.collectedData), "no purchase data leaks into the claim");
  await c.send("AA-2026-000441");
  await c.send("AB123456");
  await c.tap("claim:policy_yes");
  await fillClaim(c, SUBS.find((s) => s.code === "theft"));
  const r = await c.tap("claim:submit");
  assert.match(bodies(r), /SIN-2026-000001/);
  assert.match(bodies(r), /Reprenons votre devis/);
  assert.equal(c.step, "destination_dates");
  assert.equal(JSON.stringify(c.session.collectedData), data, "purchase answers intact");
  assert.equal(c.session.flowKey, "purchase");
  assert.ok(!("__claim" in c.session.collectedData), "no claim data leaks into the purchase");
});

test("mid-purchase: RESTART inside the claim keeps the purchase parked; CANCEL brings it back", async () => {
  const c = conversation();
  await purchaseToEmail(c);
  await c.send("sinistre");
  await c.tap("claim:switch_yes");
  await c.send("RECOMMENCER");
  assert.equal(c.step, "claim_identify");
  assert.ok(c.session.parkedPurchase, "still parked");
  await c.send("ANNULER");
  assert.equal(c.step, "destination_dates");
});

test("BACK at the start of a claim never crosses into the purchase", async () => {
  const c = conversation();
  await purchaseToEmail(c);
  await c.send("sinistre");
  await c.tap("claim:switch_yes");
  const r = await c.send("RETOUR");
  assert.equal(c.step, "claim_identify");
  assert.match(bodies(r), /au début de la déclaration/);
});

test("waiting on a payment: claims are refused until it settles", async () => {
  const c = conversation({ session: { currentStep: "payment_wait", collectedData: { quote_reference: "QT-1" } } });
  const r = await c.send("sinistre");
  assert.match(bodies(r), /paiement est en cours/);
  assert.equal(c.step, "payment_wait");
});

/* --------------------------------------------------- language, resume */

test("language switch mid-claim re-asks the question in English", async () => {
  const c = conversation();
  await identify(c);
  await c.tap("cat:travel");
  await c.tap("sub:theft");
  const r = await c.send("english");
  assert.equal(c.session.language, "en");
  assert.match(bodies(r), /On what date did the incident happen/);
});

test("the whole claim works in English", async () => {
  const c = conversation({ session: { language: "en" } });
  await c.send("Hello");
  let r = await c.tap("menu:claim");
  assert.match(bodies(r), /policy number/);
  await c.send("AA-2026-000441");
  r = await c.send("AB123456");
  assert.match(bodies(r), /Is this the right policy/);
  await c.tap("claim:policy_yes");
  await fillClaim(c, SUBS.find((s) => s.code === "theft"), { description: "Someone stole my bag at the station." });
  r = await c.tap("claim:submit");
  assert.match(bodies(r), /Your claim has been recorded/);
});

test("resume: an unfinished claim is offered back, at the step it stopped", async () => {
  const saved = {
    policy: POLICY, flags: [], claimId: 777,
    category: { code: "travel", nameFr: "Voyage", nameEn: "Travel" },
    subcategory: { code: "theft", nameFr: "Vol", nameEn: "Theft", extraFields: [], requiredDocuments: [], optionalDocuments: [], defaultPriority: "normal" },
    incidentDate: "2026-11-05",
  };
  const c = conversation({ resumable: { claimId: 777, state: saved, step: "claim_country" } });
  await c.send("Bonjour");
  let r = await c.tap("menu:claim");
  assert.equal(c.step, "claim_resume");
  assert.match(bodies(r), /AA-2026-000441/);
  r = await c.tap("claim:resume_yes");
  assert.equal(c.step, "claim_country");
  assert.equal(c.session.claimId, 777);
  assert.equal(c.state.incidentDate, "2026-11-05");
});

test("resume declined: the old draft is abandoned and a fresh claim starts", async () => {
  const c = conversation({ resumable: { claimId: 777, state: { policy: POLICY }, step: "claim_city" } });
  await c.send("Bonjour");
  await c.tap("menu:claim");
  await c.tap("claim:resume_no");
  assert.deepEqual(c.calls.abandon.at(-1), { id: 777, reason: "replaced_by_new_claim" });
  assert.equal(c.step, "claim_identify");
});

/* ------------------------------------------------------------ tracking */

test("SUIVI <ref>: status for the owner, the same 'not found' for anyone else", async () => {
  const c = conversation({
    tracked: ({ reference, waNumber }) =>
      reference === "SIN-2026-000001" && waNumber === "2250718923194"
        ? { reference, status: "under_review", submittedAt: "2026-11-10", categoryFr: "Retard de vol", categoryEn: "Flight delay" }
        : null,
  });
  let r = await c.send("SUIVI SIN-2026-000001");
  assert.match(bodies(r), /En cours d'examen/);
  assert.match(bodies(r), /Retard de vol/);
  r = await c.send("suivi SIN-2026-000999");
  assert.match(bodies(r), /Je ne trouve pas de dossier/);
});

test("track from the menu asks for the reference", async () => {
  const c = conversation({ tracked: () => ({ reference: "SIN-2026-000001", status: "submitted", submittedAt: "2026-11-10", categoryFr: "Vol" }) });
  await c.send("Bonjour");
  await c.tap("menu:track");
  assert.equal(c.step, "claim_track");
  const r = await c.send("sin-2026-000001");
  assert.match(bodies(r), /Reçu, en attente d'examen/);
  assert.equal(c.step, "claim_closed");
});

test("tracking in the middle of a purchase answers, then re-asks the purchase question", async () => {
  const c = conversation({ tracked: () => ({ reference: "SIN-2026-000001", status: "closed", submittedAt: "2026-11-10", categoryFr: "Vol" }) });
  await purchaseToEmail(c);
  const r = await c.send("SUIVI SIN-2026-000001");
  assert.match(bodies(r), /Clôturé/);
  assert.equal(c.step, "destination_dates");
});

/* ------------------------------------------------------------- help */

test("HELP inside a claim lists the claim commands and re-asks", async () => {
  const c = conversation();
  await identify(c);
  const r = await c.send("AIDE");
  assert.match(bodies(r), /Pendant la déclaration/);
  assert.equal(c.step, "claim_category");
});

test("AGENT inside a claim keeps the claim going", async () => {
  const c = conversation();
  await identify(c);
  const r = await c.send("conseiller");
  assert.match(bodies(r), /\+225 07 00 00 00/);
  assert.equal(c.step, "claim_category");
  assert.ok(c.events.some((e) => e.type === "agent_requested"));
});

/* ---------------------------------------------- data-driven, no branches */

test("a category the client adds in the admin panel is offered and works, with no code change", async () => {
  const extra = {
    code: "pets", parentCode: "travel", nameFr: "Animal", nameEn: "Pet", hintFr: "", hintEn: "", active: true,
    requiredDocuments: [], optionalDocuments: [], defaultPriority: "high", guaranteeCodes: null,
    extraFields: [{ key: "pet_name", type: "text", required: true, label_fr: "Nom", label_en: "Name", prompt_fr: "Nom de l'animal ?", prompt_en: "Pet's name?" }],
  };
  const tree = TREE.map((p) => (p.code === "travel" ? { ...p, children: [...p.children.slice(0, 9), extra] } : p));
  const c = conversation({ tree });
  await identify(c);
  await c.tap("cat:travel");
  await c.tap("sub:pets");
  await c.send("05/11/2026");
  await c.send("France");
  const r = await c.send("Paris");
  assert.match(bodies(r), /Nom de l'animal/);
  await c.send("Rex");
  await c.send("Mon chien s'est échappé à l'aéroport.");
  assert.equal(c.step, "claim_review");
  assert.equal(c.state.fields.pet_name, "Rex");
  assert.equal(c.state.priority, "high");
});

test("a tapped button's title is never read as a command (English 'Report a claim')", async () => {
  const c = conversation({ session: { language: "en" } });
  await c.send("Hello");
  await c.tap("menu:buy");
  await c.send("Ali, Saif, 12/03/1990, AB1234567");
  await c.send("claim");
  assert.equal(c.step, "claim_switch_confirm");
  // WhatsApp sends the title along with the id.
  await c.send({ type: "selection", selectionId: "claim:switch_yes", selectionTitle: "Report a claim", text: "Report a claim", rawType: "interactive" });
  assert.equal(c.step, "claim_identify");
  await c.send("AA-2026-000441");
  await c.send("AB123456");
  await c.send({ type: "selection", selectionId: "claim:policy_yes", selectionTitle: "Yes, that's it", text: "Yes, that's it", rawType: "interactive" });
  assert.equal(c.step, "claim_category");
});

test("in the purchase, a plan or option titled with 'claim' does not start a claim", async () => {
  const c = conversation();
  await c.send("Bonjour");
  const r = await c.send({ type: "selection", selectionId: "menu:buy", selectionTitle: "Claims Protect", text: "Claims Protect", rawType: "interactive" });
  assert.equal(c.step, "identity");
  assert.ok(!bodies(r).includes("sinistre"));
});
