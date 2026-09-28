// src/utils/whatsapp/engine.js
//
// The conversation state machine.
//
// ARCHITECTURE NOTE — why this file sends nothing and touches no database:
// processMessage() is a pure-ish function. It takes the inbound message, the
// session row and a set of injected dependencies, and returns the replies to send
// plus the patch to apply to the session. The controller does the I/O.
//
// That split is what makes the whole customer journey testable without Meta, a
// webhook or MySQL — the highest-risk component in the milestone gets real tests
// instead of manual clicking.
//
import { translator } from "../i18n.js";
import {
  validateName,
  validatePassportNumber,
  validateEmail,
  validatePhoneE164,
  validateDateOfBirth,
  validateGender,
  validateTravelDates,
  parseGroupedIdentity,
  parseDestinationAndDates,
  ageFromDob,
} from "../validators.js";
import {
  matchCountry,
  countryLabel,
  alphaGroups,
  countriesInAlphaGroup,
  paginate,
} from "../referenceData.js";
import { computeQuotesForPlans, formatMoney, formatDate } from "../quoteEngine.js";
import { buildCoverageSummary } from "../coverageSummary.js";
import { FLOW, getStep, resolveNext, EDITABLE_STEPS } from "./flow.default.js";
import {
  COMMANDS,
  detectCommand,
  detectCommandFromSelection,
  isGreeting,
  languageForCommand,
} from "./commands.js";

/** Internal keys kept on collectedData; never shown to the customer. */
const RETURN_TO = "__returnTo";
const PLAN_OPTIONS = "__planOptions";
const PENDING_CANDIDATES = "__pendingCandidates";

/* ------------------------------------------------------------ reply helpers */

const textReply = (body, stepKey = null) => ({ kind: "text", body, stepKey });
const buttonsReply = (body, buttons, stepKey = null, extra = {}) => ({
  kind: "buttons", body, buttons, stepKey, ...extra,
});
const listReply = (body, sections, buttonText, stepKey = null, extra = {}) => ({
  kind: "list", body, sections, buttonText, stepKey, ...extra,
});

/* -------------------------------------------------------------------- parsers */

/**
 * Each parser turns raw customer input into stored fields.
 * Returns { ok: true, stores: {...}, extra? } or a validator failure
 * ({ ok: false, code, message, field? }), or { ok: false, interactive: [...] }
 * when the right answer is to show a chooser rather than an error.
 */
const PARSERS = {
  menuChoice: ({ message, t }) => {
    const id = message.selectionId || "";
    if (id === "menu:buy") return { ok: true, stores: {} };
    if (id === "menu:question") {
      return {
        ok: false,
        handled: true,
        replies: [textReply(t("help.text"), "welcome")],
        stay: true,
      };
    }
    // Typed text at the menu: treat anything as intent to buy — a customer who
    // writes "I want insurance" should not be told to press a button.
    if (message.text) return { ok: true, stores: {} };
    return { ok: false, code: "generic", message: t("error.generic") };
  },

  lastName: ({ text }) => wrapValue(validateName(text, "Last name"), "last_name"),
  firstName: ({ text }) => wrapValue(validateName(text, "First name"), "first_name"),
  dateOfBirth: ({ text }) => wrapValue(validateDateOfBirth(text), "date_of_birth"),
  passport: ({ text }) => wrapValue(validatePassportNumber(text), "passport_or_id"),
  email: ({ text }) => wrapValue(validateEmail(text), "email"),

  phone: ({ text, session }) => {
    const cc = countryCodeFromWaNumber(session.waNumber);
    return wrapValue(validatePhoneE164(text, { defaultCountryCode: cc }), "phone");
  },

  gender: ({ message, text }) => {
    const id = message.selectionId || "";
    if (id.startsWith("gender:")) {
      const value = id.slice("gender:".length);
      const check = validateGender(value);
      return check.ok ? { ok: true, stores: { gender: check.value } } : check;
    }
    return wrapValue(validateGender(text), "gender");
  },

  groupedIdentity: ({ text }) => {
    const r = parseGroupedIdentity(text);
    if (!r.ok) return r;
    return { ok: true, stores: r.value };
  },

  travelDates: ({ text, now }) => {
    const r = validateTravelDates(...splitTwoDates(text), { now });
    if (!r.ok) return r;
    return {
      ok: true,
      stores: { start_date: r.value.start_date, end_date: r.value.end_date, stay_days: r.value.days },
    };
  },

  country: async ({ message, text, step, ctx, session, t }) => {
    const list = step.source === "destinations" ? await ctx.deps.getDestinations() : await ctx.deps.getCountries();
    const selection = message.selectionId || "";

    // Direct pick from a list we offered.
    if (selection.startsWith("country:")) {
      const code = selection.slice("country:".length);
      const hit = list.find((c) => c.code === code);
      if (hit) return { ok: true, stores: storeCountry(step, hit, session.language) };
      return { ok: false, code: "generic", message: t("error.generic") };
    }

    // Browsing: alphabetical group, or another page of one.
    if (selection.startsWith("alpha:") || selection.startsWith("more:")) {
      const { groupId, page } = parseBrowseSelection(selection);
      return {
        ok: false,
        handled: true,
        stay: true,
        replies: [countryPageReply({ list, groupId, page, step, t, lang: session.language })],
      };
    }

    if (!text) return { ok: false, code: "generic", message: t("error.generic") };

    const { match, candidates } = matchCountry(text, list);
    if (match) return { ok: true, stores: storeCountry(step, match, session.language) };

    if (candidates.length) {
      return {
        ok: false,
        handled: true,
        stay: true,
        replies: [
          listReply(
            t(step.candidatesKey || "step.nationality.candidates"),
            [{ rows: candidates.map((c) => ({ id: `country:${c.code}`, title: countryLabel(c, session.language) })) }],
            t(step.listButtonKey || "common.select"),
            step.key
          ),
        ],
      };
    }

    // Nothing matched: explain, then offer the alphabet rather than a dead end.
    return {
      ok: false,
      handled: true,
      stay: true,
      countsAsRetry: true,
      replies: [
        textReply(t(step.notFoundKey || "step.nationality.notFound"), step.key),
        alphaGroupReply({ list, step, t, lang: session.language }),
      ],
    };
  },

  destinationAndDates: async ({ message, text, step, ctx, session, t, now }) => {
    const list = await ctx.deps.getDestinations();
    const selection = message.selectionId || "";

    if (selection.startsWith("country:")) {
      const code = selection.slice("country:".length);
      const hit = list.find((c) => c.code === code);
      if (!hit) return { ok: false, code: "generic", message: t("error.generic") };
      return {
        ok: true,
        stores: storeDestination(hit, session.language),
        // Dates were not in a button tap, so they are asked next.
        followUpPromptKey: step.datesPromptKey,
      };
    }

    if (selection.startsWith("alpha:") || selection.startsWith("more:")) {
      const { groupId, page } = parseBrowseSelection(selection);
      return {
        ok: false,
        handled: true,
        stay: true,
        replies: [countryPageReply({ list, groupId, page, step, t, lang: session.language })],
      };
    }

    if (!text) return { ok: false, code: "generic", message: t("error.generic") };

    const parsed = parseDestinationAndDates(text, { now });
    if (!parsed.ok) return parsed;

    const { match, candidates } = matchCountry(parsed.value.destinationText, list);

    if (!match) {
      if (candidates.length) {
        return {
          ok: false,
          handled: true,
          stay: true,
          replies: [
            listReply(
              t(step.candidatesKey),
              [{ rows: candidates.map((c) => ({ id: `country:${c.code}`, title: countryLabel(c, session.language) })) }],
              t(step.listButtonKey),
              step.key
            ),
          ],
        };
      }
      return {
        ok: false,
        handled: true,
        stay: true,
        countsAsRetry: true,
        replies: [
          textReply(t(step.notFoundKey), step.key),
          alphaGroupReply({ list, step, t, lang: session.language }),
        ],
      };
    }

    const stores = storeDestination(match, session.language);
    if (!parsed.needsDates) {
      stores.start_date = parsed.value.start_date;
      stores.end_date = parsed.value.end_date;
      stores.stay_days = parsed.value.days;
    }
    return { ok: true, stores };
  },

  plan: ({ message, session, t }) => {
    const id = message.selectionId || "";
    const options = session.collectedData?.[PLAN_OPTIONS] || [];
    if (id.startsWith("plan:")) {
      const planId = Number(id.slice("plan:".length));
      const chosen = options.find((o) => Number(o.planId) === planId);
      if (chosen) return { ok: true, stores: planStores(chosen) };
    }
    // A customer may type the plan name instead of tapping.
    if (message.text) {
      const typed = String(message.text).trim().toLowerCase();
      const chosen = options.find((o) => String(o.planName).toLowerCase() === typed);
      if (chosen) return { ok: true, stores: planStores(chosen) };
    }
    return { ok: false, code: "generic", message: t("error.generic") };
  },

  reviewChoice: ({ message, t }) => {
    const id = message.selectionId || "";
    if (id === "quote:confirm") return { ok: true, stores: {}, action: "confirm" };
    if (id === "quote:edit") return { ok: true, stores: {}, action: "edit" };
    if (id === "quote:cancel") return { ok: true, stores: {}, action: "cancel" };
    return { ok: false, code: "generic", message: t("error.generic") };
  },

  editChoice: ({ message, t }) => {
    const id = message.selectionId || "";
    if (id.startsWith("edit:")) {
      const stepKey = id.slice("edit:".length);
      if (EDITABLE_STEPS.includes(stepKey)) return { ok: true, stores: {}, action: "goto", target: stepKey };
    }
    return { ok: false, code: "generic", message: t("error.generic") };
  },
};

/* ------------------------------------------------------- parser support fns */

function wrapValue(result, field) {
  if (!result.ok) return result;
  return { ok: true, stores: { [field]: result.value } };
}

function storeCountry(step, country, lang) {
  const [nameField, codeField] = step.stores;
  return { [nameField]: country.name_en, [codeField]: country.code };
}

function storeDestination(country, lang) {
  return { destination: country.name_en, destination_code: country.code };
}

function planStores(option) {
  return {
    plan_id: option.planId,
    plan_name: option.planName,
    premium: option.premium,
    currency: option.currency,
    validity_days: option.validityDays,
    // Carried so the quote summary can show coverage highlights without
    // re-reading the catalogue when the review screen is rendered.
    plan_coverage_fr: option.coverageFr || null,
    plan_coverage_en: option.coverageEn || null,
  };
}

function splitTwoDates(text) {
  const parts = String(text ?? "")
    .split(/[,;|\n\r]+|\s+(?:au|to|until|jusqu'au)\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2) return [parts[0], parts[1]];
  const found = String(text ?? "").match(/\d{1,4}[.\-/]\d{1,2}[.\-/]\d{1,4}/g) || [];
  return [found[0] || "", found[1] || ""];
}

function parseBrowseSelection(selection) {
  if (selection.startsWith("alpha:")) return { groupId: selection, page: 0 };
  // more:alpha:AC:2
  const m = /^more:(alpha:[A-Z]{2}):(\d+)$/.exec(selection);
  if (m) return { groupId: m[1], page: Number(m[2]) };
  return { groupId: null, page: 0 };
}

function alphaGroupReply({ list, step, t, lang }) {
  const groups = alphaGroups(list, lang);
  return listReply(
    t(step.listPromptKey || "common.choose"),
    [{ rows: groups.map((g) => ({ id: g.id, title: g.label, description: `${g.count}` })) }],
    t(step.listButtonKey || "common.select"),
    step.key
  );
}

function countryPageReply({ list, groupId, page, step, t, lang }) {
  const members = countriesInAlphaGroup(list, groupId, lang);
  const pageData = paginate(members, page);
  const rows = pageData.items.map((c) => ({ id: `country:${c.code}`, title: countryLabel(c, lang) }));
  if (pageData.hasMore) {
    rows.push({ id: `more:${groupId}:${page + 1}`, title: t("common.more") });
  }
  return listReply(
    t(step.listPromptKey || "common.choose"),
    [{ rows }],
    t(step.listButtonKey || "common.select"),
    step.key
  );
}

function countryCodeFromWaNumber(waNumber) {
  // WhatsApp gives the number in international form without "+". Dialling codes
  // are 1–3 digits and not self-delimiting, so this covers the common African
  // and European codes the client sells in, and returns null otherwise rather
  // than guessing — validatePhoneE164 then asks for the country code explicitly.
  const digits = String(waNumber || "").replace(/\D/g, "");
  const known = ["225", "242", "243", "237", "221", "223", "226", "227", "228", "229", "233", "234", "241", "250", "257", "261", "212", "213", "216", "20", "27", "44", "33", "32", "34", "39", "49", "92", "91", "1"];
  for (const code of known.sort((a, b) => b.length - a.length)) {
    if (digits.startsWith(code)) return code;
  }
  return null;
}

/* ------------------------------------------------------------ step rendering */

/**
 * Build the message(s) that ask a step's question.
 * Async because dynamic steps (plans) need pricing before they can be rendered.
 */
export async function renderStep(stepKey, session, ctx) {
  const t = translator(session.language);
  const flow = ctx.flow || FLOW;
  const step = getStep(flow, stepKey);
  if (!step) return { replies: [textReply(t("system.error"))], patch: {} };

  const data = session.collectedData || {};

  switch (step.type) {
    case "buttons":
      return {
        replies: [
          buttonsReply(
            t(step.promptKey),
            (step.options || []).map((o) => ({ id: o.id, title: t(o.labelKey) })),
            step.key
          ),
        ],
        patch: { currentStep: step.key },
      };

    case "text":
      return { replies: [textReply(t(step.promptKey), step.key)], patch: { currentStep: step.key } };

    case "dynamic_list":
      if (step.source === "plans") return renderPlanStep(session, ctx, step, t);
      // Country-style steps ask in free text first; the list is the fallback,
      // because typing "France" is one message and browsing is three.
      return { replies: [textReply(t(step.promptKey), step.key)], patch: { currentStep: step.key } };

    case "list":
      if (step.key === "review_edit") return renderEditList(session, ctx, step, t);
      return { replies: [textReply(t(step.promptKey), step.key)], patch: { currentStep: step.key } };

    case "quote_review":
      return renderReview(session, ctx, step, t);

    case "terminal":
      return {
        replies: [textReply(t(step.promptKey, { reference: data.quote_reference || "" }), step.key)],
        patch: { currentStep: step.key, status: "completed" },
      };

    default:
      return { replies: [textReply(t("system.error"))], patch: {} };
  }
}

async function renderPlanStep(session, ctx, step, t) {
  const data = session.collectedData || {};
  const plans = await ctx.deps.getPlans();
  const destination = data.destination_code ? await ctx.deps.getCountryByCode(data.destination_code) : null;

  const { priced } = computeQuotesForPlans({
    plans,
    destination,
    startDate: data.start_date,
    endDate: data.end_date,
    stayDays: data.stay_days,
    dateOfBirth: data.date_of_birth,
  });

  if (!priced.length) {
    // No plan can cover this trip: say so and hand off rather than looping.
    return {
      replies: [textReply(t(step.noneKey || "step.plan.none"), step.key)],
      patch: { currentStep: step.key, status: "escalated" },
      events: [{ type: "no_plan_available", data: { destination: data.destination, stayDays: data.stay_days } }],
    };
  }

  // Coverage lines: the plan's manual summary when an operator wrote one, and
  // otherwise derived from its own `guarantees`. Deriving keeps chat wording in
  // step with the plan automatically — an edited guarantee changes the quote
  // message without anyone remembering to rewrite a second description.
  const planById = new Map(plans.map((p) => [p.id, p]));

  const options = priced.map((q) => {
    const row = planById.get(q.plan.id);
    const currency = q.pricing.currency;
    return {
      planId: q.plan.id,
      planName: q.plan.name,
      premium: q.pricing.total,
      currency,
      validityDays: q.travel.validityDays,
      coverageFr:
        q.plan.coverageSummaryFr ||
        buildCoverageSummary(row?.pricing_rules, { lang: "fr", currency }),
      coverageEn:
        q.plan.coverageSummaryEn ||
        buildCoverageSummary(row?.pricing_rules, { lang: "en", currency }),
    };
  });

  const patch = {
    currentStep: step.key,
    collectedData: { ...data, [PLAN_OPTIONS]: options },
  };

  // One option means there is nothing to choose: skip a whole customer message.
  if (options.length === 1 && step.autoSkipWhenSingle) {
    const merged = { ...patch.collectedData, ...planStores(options[0]) };
    const nextSession = { ...session, collectedData: merged, currentStep: "review" };
    const review = await renderStep("review", nextSession, ctx);
    return {
      replies: review.replies,
      patch: {
        ...patch,
        collectedData: merged,
        currentStep: "review",
        stepHistory: [...(session.stepHistory || []), step.key],
        ...review.patch,
      },
    };
  }

  const rows = options.slice(0, 10).map((o) => ({
    id: `plan:${o.planId}`,
    title: o.planName,
    description: t("step.plan.rowDescription", {
      premium: formatMoney(o.premium, o.currency, session.language),
      days: o.validityDays ?? data.stay_days,
    }),
  }));

  return {
    replies: [listReply(t(step.promptKey), [{ rows }], t(step.listButtonKey), step.key)],
    patch,
  };
}

function renderEditList(session, ctx, step, t) {
  const flow = ctx.flow || FLOW;
  const data = session.collectedData || {};

  const rows = EDITABLE_STEPS
    .map((key) => getStep(flow, key))
    .filter((s) => s && s.editable)
    // Only offer fields that were actually collected, so the list stays short.
    .filter((s) => (s.stores || []).some((field) => data[field] !== undefined && data[field] !== null))
    .slice(0, 10)
    .map((s) => ({ id: `edit:${s.key}`, title: t(s.editLabelKey) }));

  return {
    replies: [listReply(t(step.promptKey), [{ rows }], t(step.listButtonKey), step.key)],
    patch: { currentStep: step.key },
  };
}

/**
 * The review screen doubles as the quote, so confirming costs one tap.
 * It is rendered from stored fields plus the chosen plan option.
 */
function renderReview(session, ctx, step, t) {
  const data = session.collectedData || {};
  const lang = session.language;
  const currency = data.currency || "XOF";

  const age = data.date_of_birth ? ageFromDob(data.date_of_birth) : null;
  const coverage = lang === "en" ? data.plan_coverage_en : data.plan_coverage_fr;

  const lines = [
    // No reference exists until the customer confirms, so the review screen uses
    // a title without one rather than printing a "not provided" placeholder.
    data.quote_reference
      ? t("quote.title", { reference: data.quote_reference })
      : t("quote.titleDraft"),
    "",
    t("quote.plan", { plan: data.plan_name || "—" }),
    t("quote.destination", { destination: data.destination || "—" }),
    data.start_date && data.end_date
      ? t("quote.dates", { start: formatDate(data.start_date, lang), end: formatDate(data.end_date, lang) })
      : null,
    t("quote.duration", { days: data.validity_days ?? data.stay_days ?? "—" }),
    t("quote.traveller", {
      name: `${data.first_name || ""} ${data.last_name || ""}`.trim() || "—",
      age: age ?? "—",
    }),
    "",
    `${t("review.nationality")}: ${data.nationality || "—"}`,
    `${t("review.residence")}: ${data.country_of_residence || "—"}`,
    `${t("review.passport")}: ${data.passport_or_id || "—"}`,
    `${t("review.email")}: ${data.email || "—"}`,
    `${t("review.phone")}: ${data.phone || `+${session.waNumber}`}`,
    "",
    coverage ? t("quote.coverage", { coverage }) : null,
    t("quote.premium", { amount: formatMoney(data.premium, currency, lang) }),
    "",
    t("quote.question"),
  ].filter((l) => l !== null);

  return {
    replies: [
      buttonsReply(
        lines.join("\n"),
        (step.options || []).map((o) => ({ id: o.id, title: t(o.labelKey) })),
        step.key
      ),
    ],
    patch: { currentStep: step.key },
  };
}

/* ---------------------------------------------------------------- entry point */

/**
 * Handle one inbound message.
 *
 * @param {object} args
 * @param {object} args.message  normalised message from parser.js
 * @param {object} args.session  session row (mapped), or null for first contact
 * @param {object} args.ctx      { flow, config, deps, now }
 * @returns {Promise<{replies: object[], patch: object, events: object[], countsAsCustomerMessage: boolean}>}
 */
export async function processMessage({ message, session, ctx }) {
  const flow = ctx.flow || FLOW;
  const now = ctx.now || new Date();
  const maxRetries = ctx.config?.maxFieldRetries || 3;

  const activeSession = session || {
    id: null,
    waNumber: message.from,
    language: ctx.config?.defaultLanguage || "fr",
    currentStep: null,
    stepHistory: [],
    collectedData: {},
    retryCount: 0,
    status: "active",
  };

  let t = translator(activeSession.language);
  const events = [];

  /* --- 1. Unsupported content: answer politely, never go silent ----------- */
  if (message.type === "unsupported") {
    const kind = message.unsupportedKind || "generic";
    const keyByKind = {
      image: "unsupported.image",
      video: "unsupported.video",
      audio: "unsupported.audio",
      voice: "unsupported.audio",
      document: "unsupported.document",
      location: "unsupported.location",
      sticker: "unsupported.sticker",
    };
    const replies = [textReply(t(keyByKind[kind] || "unsupported.generic"))];
    // Re-ask the current question so the customer knows where they are.
    if (activeSession.currentStep) {
      const again = await renderStep(activeSession.currentStep, activeSession, ctx);
      replies.push(...again.replies);
    }
    return { replies, patch: {}, events, countsAsCustomerMessage: false };
  }

  if (message.type === "system") {
    return { replies: [], patch: {}, events, countsAsCustomerMessage: false };
  }

  const rawText = (message.text || "").trim();
  if (!rawText && !message.selectionId) {
    return {
      replies: [textReply(t("unsupported.emptyMessage"))],
      patch: {}, events, countsAsCustomerMessage: false,
    };
  }
  if (rawText.length > 3000) {
    return {
      replies: [textReply(t("unsupported.tooLong"))],
      patch: {}, events, countsAsCustomerMessage: true,
    };
  }

  /* --- 2. Global commands, from typed text or a button id ----------------- */
  const command = detectCommandFromSelection(message.selectionId) || detectCommand(rawText);
  if (command) {
    return handleCommand({ command, session: activeSession, ctx, flow, events });
  }

  /* --- 3. First contact, or a greeting with no conversation in progress --- */
  if (!activeSession.currentStep) {
    const greeting = t("welcome.greeting", {
      name: message.profileName ? ` ${message.profileName}` : "",
    });
    const welcomeStep = getStep(flow, flow.startStep);
    const rendered = await renderStep(flow.startStep, activeSession, ctx);
    const [first, ...rest] = rendered.replies;
    const merged = first?.kind === "buttons"
      ? [{ ...first, body: `${greeting}\n\n${first.body}` }, ...rest]
      : [textReply(greeting), ...rendered.replies];

    return {
      replies: merged,
      patch: { ...rendered.patch, currentStep: welcomeStep?.key || flow.startStep },
      events,
      countsAsCustomerMessage: true,
    };
  }

  /* --- 4. Parse the answer for the current step --------------------------- */
  const step = getStep(flow, activeSession.currentStep);
  if (!step) {
    // The stored step no longer exists (a flow edit). Restart cleanly rather
    // than trapping the customer in a step nothing can answer.
    const rendered = await renderStep(flow.startStep, activeSession, ctx);
    return {
      replies: rendered.replies,
      patch: { ...rendered.patch, retryCount: 0 },
      events,
      countsAsCustomerMessage: true,
    };
  }

  const parser = PARSERS[step.parser];
  if (!parser) {
    return { replies: [textReply(t("system.error"))], patch: {}, events, countsAsCustomerMessage: true };
  }

  const parsed = await parser({ message, text: rawText, step, session: activeSession, ctx, t, now });

  /* --- 4a. The parser answered on its own (chooser, help) ----------------- */
  if (!parsed.ok && parsed.handled) {
    const patch = {};
    if (parsed.countsAsRetry) {
      const retryCount = (activeSession.retryCount || 0) + 1;
      patch.retryCount = retryCount;
      if (retryCount >= maxRetries && step.fallback?.length) {
        return switchToFallback({ step, session: activeSession, ctx, t, events });
      }
    }
    return { replies: parsed.replies || [], patch, events, countsAsCustomerMessage: true };
  }

  /* --- 4b. Validation failure: correct ONE field, never restart ----------- */
  if (!parsed.ok) {
    const retryCount = (activeSession.retryCount || 0) + 1;

    if (retryCount >= maxRetries && step.fallback?.length) {
      return switchToFallback({ step, session: activeSession, ctx, t, events });
    }

    const errorText = parsed.code ? t(`error.${parsed.code}`, {}, parsed.message) : t("error.generic");
    const replies = [textReply(errorText, step.key)];
    // Re-ask, unless the step's question is long — repeating a 4-line prompt
    // every time is noise; the error message already says what is wrong.
    if (retryCount === 1 || step.type !== "text") {
      const again = await renderStep(step.key, activeSession, ctx);
      replies.push(...again.replies);
    }
    return { replies, patch: { retryCount }, events, countsAsCustomerMessage: true };
  }

  /* --- 5. Success: store, then decide where to go ------------------------- */
  let data = { ...(activeSession.collectedData || {}), ...(parsed.stores || {}) };

  // Country of residence is defaulted from nationality instead of being asked.
  if (step.key === "nationality" && !data.country_of_residence) {
    data.country_of_residence = data.nationality;
    data.residence_code = data.nationality_code;
  }

  const history = [...(activeSession.stepHistory || []), step.key];
  const sessionAfter = { ...activeSession, collectedData: data, stepHistory: history, retryCount: 0 };

  /* --- 5a. Review screen actions ----------------------------------------- */
  if (parsed.action === "confirm") {
    return confirmQuote({ session: sessionAfter, ctx, t, events });
  }
  if (parsed.action === "cancel") {
    return {
      replies: [textReply(t("quote.cancelled"), "review")],
      patch: { status: "cancelled", collectedData: data, stepHistory: history, retryCount: 0 },
      events: [...events, { type: "quote_cancelled" }],
      countsAsCustomerMessage: true,
    };
  }
  if (parsed.action === "edit") {
    const rendered = await renderStep("review_edit", sessionAfter, ctx);
    return {
      replies: rendered.replies,
      patch: { ...rendered.patch, collectedData: data, stepHistory: history, retryCount: 0 },
      events,
      countsAsCustomerMessage: true,
    };
  }
  if (parsed.action === "goto") {
    // Editing a single field: remember to come back to the review screen.
    const withReturn = { ...data, [RETURN_TO]: "review" };
    const rendered = await renderStep(parsed.target, { ...sessionAfter, collectedData: withReturn }, ctx);
    return {
      replies: rendered.replies,
      patch: { ...rendered.patch, collectedData: withReturn, stepHistory: history, retryCount: 0 },
      events,
      countsAsCustomerMessage: true,
    };
  }

  /* --- 5b. Returning from an edit ---------------------------------------- */
  if (data[RETURN_TO]) {
    const target = data[RETURN_TO];
    const cleaned = { ...data };
    delete cleaned[RETURN_TO];
    const nextSession = { ...sessionAfter, collectedData: cleaned };
    const rendered = await renderStep(target, nextSession, ctx);
    return {
      replies: [textReply(t("review.editDone")), ...rendered.replies],
      patch: { ...rendered.patch, collectedData: cleaned, stepHistory: history, retryCount: 0 },
      events,
      countsAsCustomerMessage: true,
    };
  }

  /* --- 5c. A parser that needs one extra question (dates after country) -- */
  if (parsed.followUpPromptKey) {
    return {
      replies: [textReply(t(parsed.followUpPromptKey), step.key)],
      patch: { collectedData: data, stepHistory: history, retryCount: 0, currentStep: step.key },
      events,
      countsAsCustomerMessage: true,
    };
  }

  /* --- 5d. Normal advance ------------------------------------------------ */
  const nextKey = resolveNext(step, data);
  if (!nextKey) {
    return {
      replies: [textReply(t("system.error"))],
      patch: { collectedData: data, stepHistory: history, retryCount: 0 },
      events,
      countsAsCustomerMessage: true,
    };
  }

  const nextSession = { ...sessionAfter, currentStep: nextKey };
  const rendered = await renderStep(nextKey, nextSession, ctx);

  return {
    replies: rendered.replies,
    patch: {
      ...rendered.patch,
      collectedData: rendered.patch?.collectedData || data,
      stepHistory: history,
      retryCount: 0,
    },
    events: [...events, ...(rendered.events || [])],
    countsAsCustomerMessage: true,
  };
}

/* --------------------------------------------------------------- commands */

async function handleCommand({ command, session, ctx, flow, events }) {
  const t = translator(session.language);

  if (command === COMMANDS.HELP) {
    const replies = [textReply(t("help.text"))];
    if (session.currentStep) {
      const again = await renderStep(session.currentStep, session, ctx);
      replies.push(...again.replies);
    }
    return { replies, patch: {}, events, countsAsCustomerMessage: true };
  }

  if (command === COMMANDS.RESTART) {
    const blank = { ...session, collectedData: {}, stepHistory: [], currentStep: null, retryCount: 0 };
    const rendered = await renderStep(flow.startStep, blank, ctx);
    return {
      replies: [textReply(t("session.restarted")), ...rendered.replies],
      patch: {
        ...rendered.patch,
        collectedData: {},
        stepHistory: [],
        retryCount: 0,
        status: "active",
        caseId: null,
        quoteReference: null,
      },
      events: [...events, { type: "restarted" }],
      countsAsCustomerMessage: true,
    };
  }

  if (command === COMMANDS.BACK) {
    const history = [...(session.stepHistory || [])];
    const previous = history.pop();
    if (!previous) {
      const replies = [textReply(t("session.noPrevious"))];
      if (session.currentStep) {
        const again = await renderStep(session.currentStep, session, ctx);
        replies.push(...again.replies);
      }
      return { replies, patch: {}, events, countsAsCustomerMessage: true };
    }
    const rendered = await renderStep(previous, { ...session, currentStep: previous }, ctx);
    return {
      replies: rendered.replies,
      patch: { ...rendered.patch, stepHistory: history, retryCount: 0 },
      events,
      countsAsCustomerMessage: true,
    };
  }

  if (command === COMMANDS.AGENT) {
    const number = ctx.config?.escalationNumber;
    const replies = [
      textReply(number ? t("agent.withNumber", { number }) : t("agent.requested")),
      textReply(t("agent.resume")),
    ];
    return {
      replies,
      // The conversation is NOT closed: the customer can carry on while waiting.
      patch: {},
      events: [...events, { type: "agent_requested", data: { step: session.currentStep } }],
      countsAsCustomerMessage: true,
    };
  }

  if (command === COMMANDS.CANCEL) {
    return {
      replies: [textReply(t("session.cancelled"))],
      patch: { status: "cancelled" },
      events: [...events, { type: "quote_cancelled" }],
      countsAsCustomerMessage: true,
    };
  }

  const language = languageForCommand(command);
  if (language) {
    const switched = { ...session, language };
    const t2 = translator(language);
    const replies = [textReply(t2("language.switched"))];
    if (session.currentStep) {
      const again = await renderStep(session.currentStep, switched, ctx);
      replies.push(...again.replies);
    }
    return { replies, patch: { language }, events, countsAsCustomerMessage: true };
  }

  return { replies: [textReply(t("error.generic"))], patch: {}, events, countsAsCustomerMessage: true };
}

/**
 * Repeated failures on a grouped step: drop to one field at a time.
 * This is the milestone's "fallback to simpler prompting" requirement, and it is
 * why grouping four fields into one message is safe to attempt at all.
 */
async function switchToFallback({ step, session, ctx, t, events }) {
  const firstFallback = step.fallback[0];
  const rendered = await renderStep(firstFallback, { ...session, currentStep: firstFallback }, ctx);
  return {
    replies: [textReply(t("step.personalInfo.promptSimple")), ...rendered.replies],
    patch: { ...rendered.patch, retryCount: 0 },
    events: [...events, { type: "fallback_to_simple_prompts", data: { from: step.key } }],
    countsAsCustomerMessage: true,
  };
}

/* ------------------------------------------------------------ confirmation */

async function confirmQuote({ session, ctx, t, events }) {
  const data = session.collectedData || {};

  const persisted = await ctx.deps.persistQuote({ session, collectedData: data });
  if (!persisted?.ok) {
    const key = persisted?.code === "age_ineligible" ? "quote.ineligible"
      : persisted?.code === "no_price" ? "quote.noPrice"
      : "system.error";
    return {
      replies: [textReply(t(key))],
      patch: { status: persisted?.code === "age_ineligible" ? "escalated" : "active" },
      events: [...events, { type: "quote_persist_failed", data: { code: persisted?.code } }],
      countsAsCustomerMessage: true,
    };
  }

  const withRef = { ...data, quote_reference: persisted.quoteReference };
  return {
    replies: [textReply(t("quote.confirmed", { reference: persisted.quoteReference }), "done")],
    patch: {
      currentStep: "done",
      status: "completed",
      collectedData: withRef,
      quoteReference: persisted.quoteReference,
      caseId: persisted.caseId,
      travellerId: persisted.travellerId,
    },
    events: [
      ...events,
      { type: "quote_confirmed", data: { quoteReference: persisted.quoteReference, caseId: persisted.caseId } },
    ],
    countsAsCustomerMessage: true,
  };
}

export const __testables = { PARSERS, splitTwoDates, countryCodeFromWaNumber, parseBrowseSelection };
