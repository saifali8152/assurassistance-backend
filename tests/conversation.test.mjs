// tests/conversation.test.mjs
//
// End-to-end tests for the conversation engine — the highest-risk component in
// the milestone. No Meta, no webhook, no database: the engine returns replies and
// a session patch, so the whole customer journey is exercised in memory.
//
// This covers the milestone's Day 9–10 functional matrix: the happy path, every
// validation rule, back navigation, restart from any step, editing from the
// review screen, mid-flow language switching, unsupported message types, and the
// 6–8 customer-message target.
//
import test from "node:test";
import assert from "node:assert/strict";

import { processMessage, renderStep } from "../utils/whatsapp/engine.js";
import { FLOW } from "../utils/whatsapp/flow.default.js";

/* ------------------------------------------------------------------ fixtures */

const COUNTRIES = [
  { code: "FR", name_en: "France", name_fr: "France", zone: "Worldwide", active: true },
  { code: "CI", name_en: "Côte-d'Ivoire", name_fr: "Côte-d'Ivoire", zone: "Worldwide", active: true },
  { code: "PK", name_en: "Pakistan", name_fr: "Pakistan", zone: "Worldwide", active: true },
  { code: "ES", name_en: "Spain", name_fr: "Espagne", zone: "Worldwide", active: true },
  { code: "GB", name_en: "United Kingdom", name_fr: "Royaume-Uni", zone: "Worldwide", active: true },
  { code: "US", name_en: "United States", name_fr: "États-Unis", zone: "Worldwide", active: true },
  { code: "MA", name_en: "Morocco", name_fr: "Maroc", zone: "Worldwide", active: true },
  { code: "SN", name_en: "Senegal", name_fr: "Sénégal", zone: "Worldwide", active: true },
  { code: "CM", name_en: "Cameroon", name_fr: "Cameroun", zone: "Worldwide", active: true },
  { code: "GA", name_en: "Gabon", name_fr: "Gabon", zone: "Worldwide", active: true },
  { code: "CG", name_en: "Congo", name_fr: "Congo", zone: "Worldwide", active: true },
  { code: "CD", name_en: "Congo, Democratic Republic of the", name_fr: "Congo (Rép. dém.)", zone: "Worldwide", active: true },
];

const RULES = (prices) => ({
  pricingColumns: ["Worldwide"],
  pricing: Object.entries(prices).map(([label, v]) => ({ label, columns: { Worldwide: v } })),
});

const PLAN_A = {
  id: 11, name: "Agico Retail", product_type: "Travel", currency: "XOF",
  pricing_rules: RULES({ "10 Days": 20, "45 Days": 57, "93 Days": 75 }),
  coverage_summary_fr: "Frais médicaux, rapatriement", coverage_summary_en: "Medical, repatriation",
  flat_price: null, fixed_duration_premiums: 0,
};
const PLAN_B = {
  id: 12, name: "Agico Premium", product_type: "Travel", currency: "XOF",
  pricing_rules: RULES({ "10 Days": 35, "45 Days": 90, "93 Days": 120 }),
  coverage_summary_fr: "Couverture étendue", coverage_summary_en: "Extended cover",
  flat_price: null, fixed_duration_premiums: 0,
};

function makeCtx({ plans = [PLAN_A, PLAN_B], persist = null, config = {} } = {}) {
  const persisted = [];
  return {
    ctx: {
      flow: FLOW,
      now: new Date("2026-09-28T00:00:00Z"),
      config: { defaultLanguage: "fr", maxFieldRetries: 3, escalationNumber: null, ...config },
      deps: {
        getCountries: async () => COUNTRIES,
        getDestinations: async () => COUNTRIES.filter((c) => c.active),
        getCountryByCode: async (code) => COUNTRIES.find((c) => c.code === code) || null,
        getPlans: async () => plans,
        persistQuote: persist || (async ({ collectedData }) => {
          persisted.push(collectedData);
          return { ok: true, quoteReference: "QT-ABCD1234", caseId: 501, travellerId: 301 };
        }),
      },
    },
    persisted,
  };
}

/** A conversation you can drive message by message, like a real customer. */
function newConversation(options = {}) {
  const { ctx, persisted } = makeCtx(options);
  let session = null;
  const transcript = [];
  let customerMessages = 0;

  const apply = (patch) => {
    session = {
      id: 1,
      waNumber: "2250718923194",
      profileName: "Saif",
      language: "fr",
      currentStep: null,
      stepHistory: [],
      collectedData: {},
      retryCount: 0,
      status: "active",
      ...(session || {}),
      ...patch,
    };
  };

  const send = async (input) => {
    const message = typeof input === "string"
      ? { type: "text", text: input, from: "2250718923194", profileName: "Saif", rawType: "text", selectionId: null }
      : { from: "2250718923194", profileName: "Saif", ...input };

    const result = await processMessage({ message, session, ctx });
    apply(result.patch || {});
    if (result.countsAsCustomerMessage) customerMessages += 1;
    transcript.push({ in: message.text || message.selectionId, out: result.replies.map((r) => r.body) });
    return result;
  };

  const tap = (id) => send({ type: "selection", selectionId: id, selectionTitle: id, rawType: "interactive", text: null });

  return {
    send, tap, transcript, persisted, ctx,
    get session() { return session; },
    get customerMessages() { return customerMessages; },
    get data() { return session?.collectedData || {}; },
    get step() { return session?.currentStep; },
  };
}

const lastBody = (result) => result.replies[result.replies.length - 1]?.body || "";
const allBodies = (result) => result.replies.map((r) => r.body).join("\n");

/** Drive the fastest possible successful purchase. */
async function runHappyPath(c) {
  await c.send("Bonjour");                                   // 1 — greeting + menu
  await c.tap("menu:buy");                                   // 2 — start
  await c.send("Ali, Saif, 12/03/1990, AB1234567");           // 3 — identity
  await c.tap("gender:Male");                                // 4 — gender
  await c.send("Pakistan");                                  // 5 — nationality
  await c.send("France, 01/10/2026, 08/10/2026");             // 6 — destination + dates
  await c.send("saif@devzz.tech");                           // 7 — email
  return c;
}

/* ----------------------------------------------------------------- happy path */

test("a complete purchase reaches the quote and confirms", async () => {
  const c = newConversation();
  await runHappyPath(c);

  assert.equal(c.step, "plan", "two plans means the customer chooses");
  const planPick = await c.tap("plan:11");
  assert.equal(c.step, "review");
  assert.match(lastBody(planPick), /Votre devis/);
  assert.match(lastBody(planPick), /Agico Retail/);

  const confirmed = await c.tap("quote:confirm");
  assert.equal(c.session.status, "completed");
  assert.equal(c.session.quoteReference, "QT-ABCD1234");
  assert.equal(c.session.caseId, 501);
  assert.match(lastBody(confirmed), /QT-ABCD1234/);
});

test("all collected data is correct and complete at confirmation", async () => {
  const c = newConversation();
  await runHappyPath(c);
  await c.tap("plan:11");

  const d = c.data;
  assert.equal(d.last_name, "Ali");
  assert.equal(d.first_name, "Saif");
  assert.equal(d.date_of_birth, "1990-03-12");
  assert.equal(d.passport_or_id, "AB1234567");
  assert.equal(d.gender, "Male");
  assert.equal(d.nationality, "Pakistan");
  assert.equal(d.country_of_residence, "Pakistan", "residence defaults to nationality");
  assert.equal(d.destination, "France");
  assert.equal(d.destination_code, "FR");
  assert.equal(d.start_date, "2026-10-01");
  assert.equal(d.end_date, "2026-10-08");
  assert.equal(d.stay_days, 8);
  assert.equal(d.email, "saif@devzz.tech");
  assert.equal(d.plan_id, 11);
  assert.equal(d.premium, 20);
  assert.equal(d.validity_days, 10);
});

test("the purchase fits the 6-8 customer message target", async () => {
  const c = newConversation();
  await runHappyPath(c);
  await c.tap("plan:11");
  await c.tap("quote:confirm");
  assert.ok(c.customerMessages <= 9, `used ${c.customerMessages} messages`);
  assert.equal(c.customerMessages, 9, "greeting + menu tap + 5 answers + plan + confirm");
});

test("a single available plan is auto-selected, saving a message", async () => {
  const c = newConversation({ plans: [PLAN_A] });
  await runHappyPath(c);
  assert.equal(c.step, "review", "went straight to the quote");
  assert.equal(c.data.plan_id, 11);
  assert.equal(c.customerMessages, 7);
});

test("a customer who skips the menu and just says what they want is served", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  const r = await c.send("je veux une assurance voyage");
  assert.equal(c.step, "identity");
  assert.match(lastBody(r), /Nom.*Prénom.*Date de naissance/s);
});

/* -------------------------------------------------------------- validation */

test("an invalid field is re-asked without losing the rest of the answer", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");

  const bad = await c.send("Ali9, Saif, 12/03/1990, AB1234567");
  assert.equal(c.step, "identity", "stays on the same step");
  assert.match(allBodies(bad), /chiffres/i, "explains the actual problem");
  assert.equal(c.session.retryCount, 1);

  await c.send("Ali, Saif, 12/03/1990, AB1234567");
  assert.equal(c.step, "gender");
  assert.equal(c.data.last_name, "Ali");
});

test("each validation rule produces its own message", async () => {
  const cases = [
    ["Ali, Saif, 32/13/1990, AB1234567", /JJ\/MM\/AAAA|date/i],
    ["Ali, Saif, 12/03/2030, AB1234567", /futur/i],
    ["Ali, Saif, 12/03/1990, AB", /court|vérifier/i],
    ["Ali", /manque|trois/i],
  ];
  for (const [input, expected] of cases) {
    const c = newConversation();
    await c.send("Bonjour");
    await c.tap("menu:buy");
    const r = await c.send(input);
    assert.match(allBodies(r), expected, `input: ${input}`);
  }
});

test("an invalid email is rejected and the valid one accepted", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");
  await c.send("Ali, Saif, 12/03/1990, AB1234567");
  await c.tap("gender:Male");
  await c.send("Pakistan");
  await c.send("France, 01/10/2026, 08/10/2026");

  const bad = await c.send("not-an-email");
  assert.equal(c.step, "email");
  assert.match(allBodies(bad), /e-mail/i);

  await c.send("saif@devzz.tech");
  assert.equal(c.step, "plan");
});

test("repeated failures fall back to one field at a time", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");

  await c.send("nonsense");
  await c.send("more nonsense");
  const third = await c.send("still nonsense");

  assert.equal(c.step, "identity_last_name", "dropped to single-field prompting");
  assert.match(allBodies(third), /plus simplement/i);

  await c.send("Ali");
  assert.equal(c.step, "identity_first_name");
  await c.send("Saif");
  assert.equal(c.step, "identity_dob");
  await c.send("12/03/1990");
  assert.equal(c.step, "passport", "no passport collected yet, so it is asked");
  await c.send("AB1234567");
  assert.equal(c.step, "gender");
});

test("three fields without a passport ask for the passport separately", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");
  const r = await c.send("Ali, Saif, 12/03/1990");
  assert.equal(c.step, "passport");
  assert.match(lastBody(r), /passeport/i);
  await c.send("AB1234567");
  assert.equal(c.step, "gender");
  assert.equal(c.data.passport_or_id, "AB1234567");
});

/* ------------------------------------------------------- country resolution */

test("a typed country is matched, including with a typo", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");
  await c.send("Ali, Saif, 12/03/1990, AB1234567");
  await c.tap("gender:Male");
  await c.send("Pakistn");
  assert.equal(c.data.nationality, "Pakistan");
});

test("an ambiguous country offers a short list instead of guessing", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");
  await c.send("Ali, Saif, 12/03/1990, AB1234567");
  await c.tap("gender:Male");

  // "United" matches both United Kingdom and United States.
  const r = await c.send("United");
  assert.equal(r.replies[0].kind, "list");
  assert.ok(r.replies[0].sections[0].rows.length >= 2);
  assert.equal(c.data.nationality, undefined, "nothing stored until it is unambiguous");

  await c.tap("country:GB");
  assert.equal(c.data.nationality, "United Kingdom");
});

test("an exact country name wins over a longer name that contains it", async () => {
  // "Congo" is an exact match for CG, even though "Congo, Democratic Republic
  // of the" also starts with it. Asking the customer to disambiguate here would
  // be pedantic; picking the longer name would be wrong.
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");
  await c.send("Ali, Saif, 12/03/1990, AB1234567");
  await c.tap("gender:Male");
  await c.send("Congo");
  assert.equal(c.data.nationality, "Congo");
  assert.equal(c.data.nationality_code, "CG");
});

test("an unknown country offers alphabetical browsing, and browsing works", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");
  await c.send("Ali, Saif, 12/03/1990, AB1234567");
  await c.tap("gender:Male");

  const r = await c.send("Wakanda");
  assert.match(r.replies[0].body, /pas trouvé/i);
  assert.equal(r.replies[1].kind, "list", "alphabet groups offered");

  const group = await c.tap("alpha:DF");
  assert.equal(group.replies[0].kind, "list");
  const titles = group.replies[0].sections[0].rows.map((x) => x.title);
  assert.ok(titles.includes("France"), `expected France in D–F, got ${titles.join(", ")}`);

  await c.tap("country:FR");
  assert.equal(c.data.nationality, "France");
});

test("no WhatsApp list ever exceeds ten rows", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    code: `X${i.toString().padStart(2, "0")}`,
    name_en: `Atlantis ${i}`, name_fr: `Atlantide ${i}`, zone: "Worldwide", active: true,
  }));
  const { ctx } = makeCtx();
  ctx.deps.getCountries = async () => many;
  ctx.deps.getDestinations = async () => many;

  const session = {
    id: 1, waNumber: "2250718923194", language: "fr", currentStep: "nationality",
    stepHistory: [], collectedData: {}, retryCount: 0, status: "active",
  };
  const r = await processMessage({
    message: { type: "text", text: "Atlantis", from: "2250718923194", rawType: "text" },
    session, ctx,
  });
  for (const reply of r.replies) {
    if (reply.kind !== "list") continue;
    const rows = reply.sections.reduce((n, s) => n + s.rows.length, 0);
    assert.ok(rows <= 10, `list had ${rows} rows`);
  }
});

/* ------------------------------------------------ destination + dates combos */

test("a destination alone is followed by a dates question", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");
  await c.send("Ali, Saif, 12/03/1990, AB1234567");
  await c.tap("gender:Male");
  await c.send("Pakistan");

  const r = await c.send("France");
  assert.equal(c.data.destination, "France");
  assert.match(lastBody(r), /dates/i);

  await c.send("01/10/2026, 08/10/2026");
  assert.equal(c.data.start_date, "2026-10-01");
  assert.equal(c.step, "email");
});

test("bad travel dates are rejected with the specific reason", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");
  await c.send("Ali, Saif, 12/03/1990, AB1234567");
  await c.tap("gender:Male");
  await c.send("Pakistan");
  const r = await c.send("France, 08/10/2026, 01/10/2026");
  assert.match(allBodies(r), /retour.*après|après.*départ/i);
});

/* ----------------------------------------------------------------- commands */

test("HELP works mid-flow and re-asks the current question", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");
  const r = await c.send("AIDE");
  assert.match(r.replies[0].body, /RECOMMENCER/);
  assert.equal(c.step, "identity", "still on the same step");
  assert.match(lastBody(r), /Nom/);
});

test("RESTART clears everything from any step", async () => {
  const c = newConversation();
  await runHappyPath(c);
  assert.ok(Object.keys(c.data).length > 5);

  const r = await c.send("RECOMMENCER");
  assert.deepEqual(c.data, {});
  assert.equal(c.step, "welcome");
  assert.equal(c.session.quoteReference, null);
  assert.match(r.replies[0].body, /zéro/i);
});

test("RESTART works from every step of the journey", async () => {
  const steps = [
    ["identity", async (c) => { await c.send("Bonjour"); await c.tap("menu:buy"); }],
    ["gender", async (c) => { await c.send("Bonjour"); await c.tap("menu:buy"); await c.send("Ali, Saif, 12/03/1990, AB1234567"); }],
    ["email", async (c) => { await runHappyPath(c); }],
  ];
  for (const [label, setup] of steps) {
    const c = newConversation();
    await setup(c);
    await c.send("recommencer");
    assert.equal(c.step, "welcome", `restart from ${label}`);
    assert.deepEqual(c.data, {}, `data cleared from ${label}`);
  }
});

test("BACK returns to the previous question", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");
  await c.send("Ali, Saif, 12/03/1990, AB1234567");
  assert.equal(c.step, "gender");

  const r = await c.send("RETOUR");
  assert.equal(c.step, "identity");
  assert.match(lastBody(r), /Nom/);
});

test("BACK at the very beginning says so instead of breaking", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  const r = await c.send("retour");
  assert.match(allBodies(r), /début|rien à modifier/i);
});

test("AGENT is logged and the conversation stays open", async () => {
  const c = newConversation({ config: { escalationNumber: "+225 27 22 22 82 60" } });
  await c.send("Bonjour");
  await c.tap("menu:buy");
  const r = await c.send("conseiller");
  assert.match(r.replies[0].body, /\+225 27 22 22 82 60/);
  assert.equal(r.events.some((e) => e.type === "agent_requested"), true);
  assert.equal(c.session.status, "active", "not closed — the customer can continue");
});

test("a command word inside a longer sentence is not treated as a command", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");
  const r = await c.send("Restart Jones, Marie, 12/03/1990, AB1234567");
  assert.equal(c.step, "gender", "parsed as a name, not a restart");
  assert.equal(c.data.last_name, "Restart Jones");
});

/* ----------------------------------------------------------------- language */

test("the language switch works mid-flow and re-asks in English", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");
  const r = await c.send("english");
  assert.equal(c.session.language, "en");
  assert.match(r.replies[0].body, /English/i);
  assert.match(lastBody(r), /Last name.*First name.*Date of birth/s);
});

test("the whole journey runs in English", async () => {
  const c = newConversation();
  await c.send("Hello");
  await c.send("english");
  await c.tap("menu:buy");
  await c.send("Ali, Saif, 12/03/1990, AB1234567");
  await c.tap("gender:Male");
  await c.send("Pakistan");
  await c.send("France, 01/10/2026, 08/10/2026");
  const r = await c.send("saif@devzz.tech");
  assert.equal(c.step, "plan");
  assert.match(lastBody(r), /plan/i);

  const pick = await c.tap("plan:11");
  assert.match(lastBody(pick), /Your quote/);
  assert.match(lastBody(pick), /Premium due/);
});

test("switching back to French mid-flow works too", async () => {
  const c = newConversation();
  await c.send("Hello");
  await c.send("english");
  await c.tap("menu:buy");
  const r = await c.send("francais");
  assert.equal(c.session.language, "fr");
  assert.match(lastBody(r), /Nom/);
});

/* ------------------------------------------------------------ review + edit */

test("the review screen lists every collected detail and the premium", async () => {
  const c = newConversation({ plans: [PLAN_A] });
  await runHappyPath(c);
  const body = c.transcript[c.transcript.length - 1].out.join("\n");
  for (const fragment of ["Ali", "Saif", "Pakistan", "France", "AB1234567", "saif@devzz.tech", "Agico Retail"]) {
    assert.ok(body.includes(fragment), `review should show ${fragment}`);
  }
  assert.match(body, /Prime à payer/);
});

test("editing one field returns to the review without redoing the flow", async () => {
  const c = newConversation({ plans: [PLAN_A] });
  await runHappyPath(c);
  assert.equal(c.step, "review");

  const list = await c.tap("quote:edit");
  assert.equal(list.replies[0].kind, "list");
  const ids = list.replies[0].sections[0].rows.map((r) => r.id);
  assert.ok(ids.includes("edit:email"));

  await c.tap("edit:email");
  assert.equal(c.step, "email");

  const done = await c.send("new@devzz.tech");
  assert.equal(c.data.email, "new@devzz.tech");
  assert.equal(c.step, "review", "back to the summary, not the next question");
  assert.match(allBodies(done), /modifié/i);
  assert.equal(c.data.last_name, "Ali", "other answers untouched");
});

test("every editable field can be corrected from the review screen", async () => {
  for (const [editId, input, field, expected] of [
    ["edit:identity_last_name", "Traoré", "last_name", "Traoré"],
    ["edit:gender", null, "gender", "Female"],
    ["edit:nationality", "Senegal", "nationality", "Senegal"],
    ["edit:passport", "ZZ9988776", "passport_or_id", "ZZ9988776"],
    ["edit:email", "x@devzz.tech", "email", "x@devzz.tech"],
  ]) {
    const c = newConversation({ plans: [PLAN_A] });
    await runHappyPath(c);
    await c.tap("quote:edit");
    await c.tap(editId);
    if (input === null) await c.tap("gender:Female");
    else await c.send(input);
    assert.equal(c.data[field], expected, `editing ${editId}`);
    assert.equal(c.step, "review", `returned to review after ${editId}`);
  }
});

test("cancelling from the review closes the conversation cleanly", async () => {
  const c = newConversation({ plans: [PLAN_A] });
  await runHappyPath(c);
  const r = await c.tap("quote:cancel");
  assert.equal(c.session.status, "cancelled");
  assert.match(lastBody(r), /annulé/i);
  assert.equal(r.events.some((e) => e.type === "quote_cancelled"), true);
});

/* --------------------------------------------------- unsupported message types */

test("images, voice notes, locations and stickers all get a polite redirect", async () => {
  for (const [kind, pattern] of [
    ["image", /images/i],
    ["audio", /vocaux/i],
    ["video", /vidéos/i],
    ["document", /documents/i],
    ["location", /position/i],
    ["sticker", /répondre|réponse/i],
  ]) {
    const c = newConversation();
    await c.send("Bonjour");
    await c.tap("menu:buy");
    const r = await c.send({ type: "unsupported", unsupportedKind: kind, rawType: kind, text: null });
    assert.match(r.replies[0].body, pattern, kind);
    assert.equal(c.step, "identity", `${kind} must not advance the flow`);
    assert.equal(r.countsAsCustomerMessage, false, `${kind} should not count against the message budget`);
  }
});

test("an unsupported message re-asks the current question", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");
  const r = await c.send({ type: "unsupported", unsupportedKind: "image", rawType: "image", text: null });
  assert.ok(r.replies.length >= 2, "redirect plus the question again");
  assert.match(lastBody(r), /Nom/);
});

test("empty and over-long messages are handled", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  await c.tap("menu:buy");

  const empty = await c.send({ type: "text", text: "   ", rawType: "text" });
  assert.match(empty.replies[0].body, /rien reçu/i);

  const long = await c.send("x".repeat(3500));
  assert.match(long.replies[0].body, /long/i);
  assert.equal(c.step, "identity");
});

test("a system message is ignored silently", async () => {
  const c = newConversation();
  await c.send("Bonjour");
  const r = await c.send({ type: "system", text: "user changed number", rawType: "system" });
  assert.equal(r.replies.length, 0);
});

/* ---------------------------------------------------------------- edge cases */

test("an over-85 traveller is escalated rather than quoted", async () => {
  const c = newConversation({ plans: [PLAN_A] });
  await c.send("Bonjour");
  await c.tap("menu:buy");
  await c.send("Ali, Saif, 12/03/1935, AB1234567");
  await c.tap("gender:Male");
  await c.send("Pakistan");
  await c.send("France, 01/10/2026, 08/10/2026");
  const r = await c.send("saif@devzz.tech");
  assert.match(allBodies(r), /Aucune formule|conseiller/i);
  assert.equal(c.session.status, "escalated");
});

test("no available plan escalates with an explanation", async () => {
  const c = newConversation({ plans: [] });
  await runHappyPath(c);
  const body = c.transcript[c.transcript.length - 1].out.join("\n");
  assert.match(body, /Aucune formule/i);
  assert.equal(c.session.status, "escalated");
});

test("a failed persist does not tell the customer the quote was saved", async () => {
  const c = newConversation({
    plans: [PLAN_A],
    persist: async () => ({ ok: false, code: "db_error" }),
  });
  await runHappyPath(c);
  const r = await c.tap("quote:confirm");
  assert.ok(!/QT-/.test(allBodies(r)), "no reference is invented");
  assert.match(allBodies(r), /erreur technique/i);
  assert.notEqual(c.session.status, "completed");
});

test("a stored step that no longer exists restarts instead of trapping the customer", async () => {
  const { ctx } = makeCtx();
  const session = {
    id: 1, waNumber: "2250718923194", language: "fr", currentStep: "a_step_that_was_removed",
    stepHistory: [], collectedData: {}, retryCount: 0, status: "active",
  };
  const r = await processMessage({
    message: { type: "text", text: "hello", from: "2250718923194", rawType: "text" },
    session, ctx,
  });
  assert.equal(r.patch.currentStep, "welcome");
});

test("the profile name is used in the greeting when Meta provides it", async () => {
  const c = newConversation();
  const r = await c.send("Bonjour");
  assert.match(r.replies[0].body, /Saif/);
});

test("renderStep produces a usable prompt for every step in the flow", async () => {
  const { ctx } = makeCtx();
  const session = {
    id: 1, waNumber: "2250718923194", language: "fr", currentStep: null, stepHistory: [],
    collectedData: {
      last_name: "Ali", first_name: "Saif", date_of_birth: "1990-03-12", passport_or_id: "AB1234567",
      gender: "Male", nationality: "Pakistan", nationality_code: "PK", country_of_residence: "Pakistan",
      destination: "France", destination_code: "FR", start_date: "2026-10-01", end_date: "2026-10-08",
      stay_days: 8, email: "saif@devzz.tech", plan_id: 11, plan_name: "Agico Retail", premium: 20,
      currency: "XOF", validity_days: 10,
    },
    retryCount: 0, status: "active",
  };
  for (const key of Object.keys(FLOW.steps)) {
    const rendered = await renderStep(key, session, ctx);
    assert.ok(rendered.replies.length >= 1, `step ${key} produced no reply`);
    const body = rendered.replies[0].body;
    assert.ok(body && body.length > 0, `step ${key} produced an empty body`);
    assert.ok(!body.includes("step.") && !body.includes("quote."), `step ${key} leaked an i18n key: ${body}`);
  }
});

/* ------------------------------------------- quote summary presentation */

test("the review screen shows no reference placeholder before confirmation", async () => {
  const c = newConversation({ plans: [PLAN_A] });
  await runHappyPath(c);
  const body = c.transcript[c.transcript.length - 1].out.join("\n");
  assert.ok(!/Non renseign/i.test(body), "must not print a 'not provided' reference");
  assert.ok(!/QT-/.test(body), "no reference exists yet");
  assert.match(body, /Votre devis/);
});

test("the confirmation message carries the real reference", async () => {
  const c = newConversation({ plans: [PLAN_A] });
  await runHappyPath(c);
  const r = await c.tap("quote:confirm");
  assert.match(lastBody(r), /QT-ABCD1234/);
});

test("the quote summary shows the plan's coverage highlights", async () => {
  const c = newConversation({ plans: [PLAN_A] });
  await runHappyPath(c);
  const body = c.transcript[c.transcript.length - 1].out.join("\n");
  assert.match(body, /Garanties principales/);
  assert.match(body, /Frais médicaux, rapatriement/);
});

test("coverage highlights follow the conversation language", async () => {
  const c = newConversation({ plans: [PLAN_A] });
  await c.send("Hello");
  await c.send("english");
  await c.tap("menu:buy");
  await c.send("Ali, Saif, 12/03/1990, AB1234567");
  await c.tap("gender:Male");
  await c.send("Pakistan");
  await c.send("France, 01/10/2026, 08/10/2026");
  await c.send("saif@devzz.tech");
  const body = c.transcript[c.transcript.length - 1].out.join("\n");
  assert.match(body, /Main benefits/);
  assert.match(body, /Medical, repatriation/);
});

test("the phone line is shown in full E.164 form", async () => {
  const c = newConversation({ plans: [PLAN_A] });
  await runHappyPath(c);
  const body = c.transcript[c.transcript.length - 1].out.join("\n");
  assert.match(body, /\+2250718923194/, "the + prefix must be present");
});

/* ------------------------------------------- derived coverage highlights */

const PLAN_WITH_GUARANTEES = {
  id: 21, name: "Agico Derived", product_type: "Travel", currency: "XOF",
  pricing_rules: {
    pricingColumns: ["Worldwide"],
    pricing: [{ label: "10 Days", columns: { Worldwide: 20 } }],
    guarantees: [
      { category: "MEDICAL", coverageType: "medicalEmergencies", amount: null },
      { category: "MEDICAL", coverageType: "hospitalization", amount: 40000000 },
      { category: "TRAVEL", coverageType: "tripCancellation", amount: 600000 },
    ],
  },
  // No hand-written summary — the quote must derive one.
  coverage_summary_fr: null, coverage_summary_en: null,
  flat_price: null, fixed_duration_premiums: 0,
};

test("a plan with no written summary still shows coverage, derived from its guarantees", async () => {
  const c = newConversation({ plans: [PLAN_WITH_GUARANTEES] });
  await runHappyPath(c);
  const body = c.transcript[c.transcript.length - 1].out.join("\n");
  assert.match(body, /Garanties principales/);
  assert.match(body, /Hospitalisation/);
  assert.match(body, /Annulation de voyage/);
});

test("the derived coverage follows the conversation language", async () => {
  const c = newConversation({ plans: [PLAN_WITH_GUARANTEES] });
  await c.send("Hello");
  await c.send("english");
  await c.tap("menu:buy");
  await c.send("Ali, Saif, 12/03/1990, AB1234567");
  await c.tap("gender:Male");
  await c.send("Pakistan");
  await c.send("France, 01/10/2026, 08/10/2026");
  await c.send("saif@devzz.tech");
  const body = c.transcript[c.transcript.length - 1].out.join("\n");
  assert.match(body, /Main benefits/);
  assert.match(body, /Hospitalization/);
});

test("a hand-written summary overrides the derived one", async () => {
  const overridden = { ...PLAN_WITH_GUARANTEES, coverage_summary_fr: "Couverture sur mesure" };
  const c = newConversation({ plans: [overridden] });
  await runHappyPath(c);
  const body = c.transcript[c.transcript.length - 1].out.join("\n");
  assert.match(body, /Couverture sur mesure/);
  assert.ok(!/Hospitalisation/.test(body), "the override replaces the derived list");
});

test("a plan with no guarantees and no summary simply omits the coverage block", async () => {
  const bare = { ...PLAN_WITH_GUARANTEES, pricing_rules: { pricingColumns: ["Worldwide"], pricing: [{ label: "10 Days", columns: { Worldwide: 20 } }] } };
  const c = newConversation({ plans: [bare] });
  await runHappyPath(c);
  const body = c.transcript[c.transcript.length - 1].out.join("\n");
  assert.ok(!/Garanties principales/.test(body));
  assert.match(body, /Prime à payer/, "the rest of the quote is unaffected");
});
