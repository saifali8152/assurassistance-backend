// src/utils/whatsapp/claimEngine.js
//
// Milestone 4 — the claim conversation.
//
// Same contract as engine.js: given the inbound message, the session and an
// injected context, return { replies, patch, events, countsAsCustomerMessage }.
// No database, no sends. Everything with a side effect (checking a policy,
// saving the draft, submitting) is a function in ctx.claims.deps, provided by
// the controller and faked in tests.
//
// WHY A SEPARATE MODULE: the purchase journey is live and must not change
// behaviour. engine.js hands a message over here only when the session is
// already in a claim step (currentStep starts with "claim_") or the customer
// asked for a claim. Every claim step is named claim_*, so the two journeys can
// never route into each other's steps.
//
// STATE: everything this journey collects lives under collectedData.__claim.
// A purchase interrupted by a claim is moved, untouched, to
// session.parkedPurchase and put back when the claim ends (D7).
//
// DATA-DRIVEN: categories, sub-categories, the extra questions, required
// documents and default priority all come from claim_categories, edited in the
// admin panel. There is no branch here for any particular kind of claim.
//
import { translator } from "../i18n.js";
import { validateDateLoose } from "../validators.js";
import { formatDate } from "../quoteEngine.js";
import { checkIncidentDate, checkCoverage, normaliseIdentifier } from "../claims/policyRules.js";
import {
  COMMANDS, detectCommand, detectCommandFromSelection, normalizeCommandText, parseTrackRequest, languageForCommand,
} from "./commands.js";

export const CLAIM_PREFIX = "claim_";
export const isClaimStep = (key) => typeof key === "string" && key.startsWith(CLAIM_PREFIX);

const STATE = "__claim";
const MAX_RETRIES = 3;

/** Steps where the customer writes free text — the loose certificate/claim
 *  readings are switched off there, so "perte de mon attestation" in a
 *  description is a description, not a command. */
const FREE_TEXT_STEPS = new Set(["claim_city", "claim_field", "claim_description"]);

/** Steps that come before the draft exists: BACK may move between them. */
const IDENTIFY_STEPS = new Set(["claim_identify", "claim_passport", "claim_policy_confirm"]);

const DONE_WORDS = ["termine", "terminer", "fini", "fin", "done", "finished", "c est tout", "that s all"];
const LATER_WORDS = ["plus tard", "later", "apres", "after"];
const SKIP_WORDS = ["passer", "passe", "skip", "aucun", "aucune", "none", "non applicable", "n a", "na"];
const YES_WORDS = ["oui", "yes", "ok", "d accord", "okay"];
const NO_WORDS = ["non", "no"];

/* -------------------------------------------------------------- replies */

const textReply = (body, stepKey = null) => ({ kind: "text", body, stepKey });
const buttonsReply = (body, buttons, stepKey = null) => ({ kind: "buttons", body, buttons, stepKey });
const listReply = (body, sections, buttonText, stepKey = null) => ({ kind: "list", body, sections, buttonText, stepKey });

const clip = (s, n) => {
  const v = String(s ?? "");
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

/* ---------------------------------------------------------------- state */

export function claimState(session) {
  return { ...(session?.collectedData?.[STATE] || {}) };
}

function withState(state) {
  return { [STATE]: state };
}

function access(ctx) {
  return ctx.claims?.access || { enabled: false, allowlisted: false, allowed: false };
}

function cfg(ctx) {
  return ctx.claims?.config || {};
}

function deps(ctx) {
  return ctx.claims?.deps || {};
}

function lang(session) {
  return session.language === "en" ? "en" : "fr";
}

function nameOf(item, l) {
  if (!item) return "";
  return (l === "en" ? item.nameEn : item.nameFr) || item.nameFr || item.nameEn || item.code || "";
}

function hintOf(item, l) {
  if (!item) return "";
  return (l === "en" ? item.hintEn : item.hintFr) || "";
}

function labelOf(obj, l, base = "label") {
  if (!obj) return "";
  return (l === "en" ? obj[`${base}_en`] : obj[`${base}_fr`]) || obj[`${base}_fr`] || obj[`${base}_en`] || "";
}

function numberSuffix(ctx, t) {
  const n = ctx.config?.escalationNumber;
  return n ? t("claim.numberSuffix", { number: n }) : "";
}

async function categoryTree(ctx) {
  try {
    const tree = (await ctx.claims?.getCategoryTree?.()) || [];
    return Array.isArray(tree) ? tree : [];
  } catch {
    return [];
  }
}

/** The sub-category as it was when chosen, kept on the session so an admin
 *  edit mid-conversation cannot change the questions under the customer. */
export function subSnapshot(sub) {
  return {
    code: sub.code,
    parentCode: sub.parentCode,
    nameFr: sub.nameFr,
    nameEn: sub.nameEn,
    requiredDocuments: sub.requiredDocuments || [],
    optionalDocuments: sub.optionalDocuments || [],
    extraFields: sub.extraFields || [],
    defaultPriority: sub.defaultPriority || "normal",
    guaranteeCodes: sub.guaranteeCodes || null,
  };
}

function hasDocuments(state) {
  const s = state.subcategory;
  return Boolean(s && ((s.requiredDocuments || []).length || (s.optionalDocuments || []).length));
}

function fieldsOf(state) {
  return state.subcategory?.extraFields || [];
}

function addFlag(state, flag) {
  const flags = new Set(state.flags || []);
  flags.add(flag);
  return [...flags];
}

function isWord(text, list) {
  const s = normalizeCommandText(text);
  return Boolean(s) && list.includes(s);
}

/** What the draft row gets after each answer. Best effort: the conversation
 *  never fails because a save did — the session still holds the answers. */
async function saveDraft(ctx, session, state, events) {
  const id = state.claimId || session.claimId;
  if (!id || typeof deps(ctx).saveDraft !== "function") return;
  try {
    await deps(ctx).saveDraft(id, {
      categoryCode: state.category?.code ?? null,
      subcategoryCode: state.subcategory?.code ?? null,
      incidentDate: state.incidentDate ?? null,
      incidentCountryCode: state.countryCode ?? null,
      incidentCountry: state.country ?? null,
      incidentCity: state.city ?? null,
      description: state.description ?? null,
      extraFields: state.fields || {},
      flags: state.flags || [],
      priority: state.priority || "normal",
      language: lang(session),
    });
  } catch (err) {
    events.push({ type: "claim_draft_save_failed", data: { claimId: id, error: err?.message } });
  }
}

/* ------------------------------------------------------------ rendering */

export async function renderClaimStep(stepKey, session, ctx) {
  const t = translator(session.language);
  const l = lang(session);
  const state = claimState(session);
  const [key, suffix] = String(stepKey).split(":");
  const at = () => ({ currentStep: stepKey });

  switch (key) {
    case "claim_switch_confirm":
      return {
        replies: [buttonsReply(t("claim.switchConfirm"), [
          { id: "claim:switch_yes", title: t("claim.switchYes") },
          { id: "claim:switch_no", title: t("claim.switchNo") },
        ], key)],
        patch: at(),
      };

    case "claim_resume":
      return {
        replies: [buttonsReply(t("claim.resumePrompt", { policy: state.resumeOffer?.policyNumber || "" }), [
          { id: "claim:resume_yes", title: t("claim.resumeYes") },
          { id: "claim:resume_no", title: t("claim.resumeNo") },
        ], key)],
        patch: at(),
      };

    case "claim_identify": {
      const mode = cfg(ctx).cardNumberMode || "certificate";
      const cardHint = mode === "separate" ? t("claim.cardHintSeparate") : mode === "certificate" ? t("claim.cardHintCertificate") : "";
      return { replies: [textReply(t("claim.identifyPrompt", { cardHint }), key)], patch: at() };
    }

    case "claim_passport":
      return { replies: [textReply(t("claim.passportPrompt"), key)], patch: at() };

    case "claim_policy_confirm": {
      const p = state.policy || {};
      const body = t("claim.policyConfirm", {
        policy: p.policyNumber || "",
        plan: p.planName || "",
        holder: p.holderFirstName || "—",
        start: formatDate(p.startDate, l),
        end: formatDate(p.endDate, l),
      });
      return {
        replies: [buttonsReply(body, [
          { id: "claim:policy_yes", title: t("claim.policyYes") },
          { id: "claim:policy_no", title: t("claim.policyNo") },
        ], key)],
        patch: at(),
      };
    }

    case "claim_category": {
      const tree = await categoryTree(ctx);
      if (!tree.length) {
        return { replies: [textReply(t("claim.notAvailable", { number: numberSuffix(ctx, t) }), key)], patch: at() };
      }
      const rows = tree.slice(0, 10).map((c) => {
        const row = { id: `cat:${c.code}`, title: clip(nameOf(c, l), 24) };
        const hint = clip(hintOf(c, l), 72);
        if (hint) row.description = hint;
        return row;
      });
      return { replies: [listReply(t("claim.categoryPrompt"), [{ rows }], t("claim.listButton"), key)], patch: at() };
    }

    case "claim_subcategory": {
      const tree = await categoryTree(ctx);
      const parent = tree.find((c) => c.code === state.category?.code);
      if (!parent) return renderClaimStep("claim_category", session, ctx);
      const rows = parent.children.slice(0, 10).map((c) => {
        const row = { id: `sub:${c.code}`, title: clip(nameOf(c, l), 24) };
        const hint = clip(hintOf(c, l), 72);
        if (hint) row.description = hint;
        return row;
      });
      return { replies: [listReply(t("claim.subcategoryPrompt"), [{ rows }], t("claim.listButton"), key)], patch: at() };
    }

    case "claim_incident_date":
      return { replies: [textReply(t("claim.incidentDatePrompt"), key)], patch: at() };

    case "claim_country":
      return { replies: [textReply(t("claim.countryPrompt"), key)], patch: at() };

    case "claim_city":
      return { replies: [textReply(t("claim.cityPrompt"), key)], patch: at() };

    case "claim_field": {
      const idx = suffix !== undefined ? Number(suffix) : Number(state.fieldIdx || 0);
      const field = fieldsOf(state)[idx];
      if (!field) return renderClaimStep("claim_description", session, ctx);
      const prompt = labelOf(field, l, "prompt") || labelOf(field, l);
      const stepId = `claim_field:${idx}`;
      if (field.type === "choice") {
        const options = (field.options || []).map((o) => ({ id: `opt:${o.value}`, title: clip(labelOf(o, l), 20) }));
        if (!field.required) options.push({ id: "opt:__skip", title: t("claim.skipButton") });
        const reply = options.length <= 3
          ? buttonsReply(prompt, options, "claim_field")
          : listReply(prompt, [{ rows: options.map((o) => ({ id: o.id, title: clip(o.title, 24) })) }], t("claim.listButton"), "claim_field");
        return { replies: [reply], patch: { currentStep: stepId } };
      }
      return { replies: [textReply(prompt, "claim_field")], patch: { currentStep: stepId } };
    }

    case "claim_description":
      return { replies: [textReply(t("claim.descriptionPrompt", { min: cfg(ctx).descriptionMin || 20 }), key)], patch: at() };

    case "claim_documents": {
      const sub = state.subcategory || {};
      const lines = [];
      if ((sub.requiredDocuments || []).length) {
        lines.push(t("claim.documentsRequired"), ...sub.requiredDocuments.map((d) => `• ${labelOf(d, l)}`));
      }
      if ((sub.optionalDocuments || []).length) {
        if (lines.length) lines.push("");
        lines.push(t("claim.documentsOptional"), ...sub.optionalDocuments.map((d) => `• ${labelOf(d, l)}`));
      }
      return { replies: [textReply(t("claim.documentsPrompt", { list: lines.join("\n") }), key)], patch: at() };
    }

    case "claim_review":
      return renderReview(t, l, state);

    case "claim_edit": {
      const rows = [
        { id: "edit:type", title: t("claim.editType") },
        { id: "edit:date", title: t("claim.editDate") },
        { id: "edit:place", title: t("claim.editPlace") },
      ];
      if (fieldsOf(state).length) rows.push({ id: "edit:details", title: t("claim.editDetails") });
      rows.push({ id: "edit:description", title: t("claim.editDescription") });
      if (hasDocuments(state)) rows.push({ id: "edit:documents", title: t("claim.editDocuments") });
      return { replies: [listReply(t("claim.editPrompt"), [{ rows }], t("claim.listButton"), key)], patch: at() };
    }

    case "claim_consent": {
      const text = consentText(ctx, l);
      return {
        replies: [buttonsReply(t("claim.consentPrompt", { text }), [
          { id: "claim:consent_yes", title: t("claim.consentAccept") },
          { id: "claim:consent_no", title: t("claim.consentDecline") },
        ], key)],
        patch: at(),
      };
    }

    case "claim_track":
      return { replies: [textReply(t("claim.trackPrompt"), key)], patch: at() };

    default:
      return { replies: [textReply(t("claim.anythingElse"), "claim_closed")], patch: { currentStep: "claim_closed" } };
  }
}

function consentText(ctx, l) {
  const c = cfg(ctx).consentText || {};
  return String(c[l] || c.fr || c.en || "").trim();
}

function renderReview(t, l, state) {
  const sep = l === "en" ? ":" : " :";
  const p = state.policy || {};
  const type = [nameOf(state.category, l), nameOf(state.subcategory, l)].filter(Boolean).join(" › ");
  const lines = [t("claim.reviewTitle"), ""];
  lines.push(`${t("claim.reviewPolicy")}${sep} ${p.policyNumber || "—"}`);
  lines.push(`${t("claim.reviewType")}${sep} ${type || "—"}`);
  lines.push(`${t("claim.reviewDate")}${sep} ${state.incidentDate ? formatDate(state.incidentDate, l) : "—"}`);
  lines.push(`${t("claim.reviewPlace")}${sep} ${[state.city, state.countryLabel || state.country].filter(Boolean).join(", ") || "—"}`);
  for (const f of fieldsOf(state)) {
    const v = (state.fields || {})[f.key];
    const shown = v === null || v === undefined || v === "" ? t("common.notProvided") : displayFieldValue(f, v, l);
    lines.push(`${labelOf(f, l)}${sep} ${shown}`);
  }
  if (hasDocuments(state)) lines.push(`${t("claim.reviewDocuments")}${sep} ${(state.documents || []).length}`);
  lines.push("", `${t("claim.reviewDescription")}${sep}`, clip(state.description || "—", 400), "", t("claim.reviewQuestion"));
  return {
    replies: [buttonsReply(lines.join("\n"), [
      { id: "claim:submit", title: t("claim.reviewSubmit") },
      { id: "claim:modify", title: t("claim.reviewModify") },
      { id: "claim:cancel", title: t("claim.reviewCancel") },
    ], "claim_review")],
    patch: { currentStep: "claim_review" },
  };
}

function displayFieldValue(field, value, l) {
  if (field.type === "choice") {
    const o = (field.options || []).find((x) => String(x.value) === String(value));
    return o ? labelOf(o, l) : String(value);
  }
  if (field.type === "date") return formatDate(value, l);
  return String(value);
}

/* ------------------------------------------------------- moving around */

/** Render a step and return the standard result, with state and history. */
async function go(stepKey, session, ctx, { state, history, replies = [], events = [], patch = {} } = {}) {
  const next = { ...session, collectedData: withState(state), currentStep: stepKey };
  const rendered = await renderClaimStep(stepKey, next, ctx);
  return {
    replies: [...replies, ...rendered.replies],
    patch: {
      flowKey: "claim",
      ...patch,
      ...rendered.patch,
      collectedData: withState(state),
      stepHistory: history ?? session.stepHistory ?? [],
      retryCount: 0,
    },
    events,
    countsAsCustomerMessage: true,
  };
}

/** After an answer: the next step in the journey, or back to the review when
 *  the answer was an edit. Chains (category → sub-category → details,
 *  country → city, field → field) are followed to their end first. */
export function nextAfter(stepKey, state) {
  const returning = state.returnTo === "claim_review";
  const fields = fieldsOf(state);
  const [key, idxRaw] = String(stepKey).split(":");
  switch (key) {
    case "claim_category": return "claim_subcategory";
    case "claim_subcategory":
      if (returning) return state.subChanged && fields.length ? "claim_field:0" : "claim_review";
      return "claim_incident_date";
    case "claim_incident_date": return returning ? "claim_review" : "claim_country";
    case "claim_country": return "claim_city";
    case "claim_city":
      if (returning) return "claim_review";
      return fields.length ? "claim_field:0" : "claim_description";
    case "claim_field": {
      const i = Number(idxRaw || 0) + 1;
      if (i < fields.length) return `claim_field:${i}`;
      return returning ? "claim_review" : "claim_description";
    }
    case "claim_description":
      if (returning) return "claim_review";
      return hasDocuments(state) ? "claim_documents" : "claim_review";
    default: return "claim_review";
  }
}

async function advance(stepKey, session, ctx, state, { replies = [], events = [] } = {}) {
  const nextKey = nextAfter(stepKey, state);
  const history = [...(session.stepHistory || []), stepKey];
  const s = { ...state };
  let out = replies;
  if (nextKey === "claim_review" && s.returnTo) {
    delete s.returnTo;
    delete s.subChanged;
    out = [...out, textReply(translator(session.language)("claim.editDone"))];
  }
  if (nextKey.startsWith("claim_field:")) s.fieldIdx = Number(nextKey.split(":")[1]);
  await saveDraft(ctx, session, s, events);
  return go(nextKey, session, ctx, { state: s, history, replies: out, events });
}

/** Leave the claim journey: back to a parked purchase, or to a resting state
 *  from which the next message opens the main menu. */
async function leave(session, ctx, helpers, { replies = [], events = [], patch = {} } = {}) {
  const t = translator(session.language);
  const parked = session.parkedPurchase;
  if (parked && parked.currentStep && typeof helpers?.renderPurchaseStep === "function") {
    const restored = {
      ...session,
      currentStep: parked.currentStep,
      stepHistory: parked.stepHistory || [],
      collectedData: parked.collectedData || {},
      retryCount: 0,
    };
    const rendered = await helpers.renderPurchaseStep(parked.currentStep, restored);
    return {
      replies: [...replies, textReply(t("claim.resumePurchase")), ...rendered.replies],
      patch: {
        ...patch,
        ...rendered.patch,
        currentStep: parked.currentStep,
        stepHistory: parked.stepHistory || [],
        collectedData: parked.collectedData || {},
        parkedPurchase: null,
        flowKey: "purchase",
        retryCount: 0,
      },
      events: [...events, { type: "purchase_resumed_after_claim" }],
      countsAsCustomerMessage: true,
    };
  }
  return {
    replies: [...replies, textReply(t("claim.anythingElse"), "claim_closed")],
    patch: { ...patch, currentStep: "claim_closed", stepHistory: [], collectedData: {}, parkedPurchase: null, retryCount: 0, flowKey: "claim" },
    events,
    countsAsCustomerMessage: true,
  };
}

async function abandonDraft(ctx, session, state, reason, events) {
  const id = state.claimId || session.claimId;
  if (!id || typeof deps(ctx).abandonDraft !== "function") return;
  try {
    await deps(ctx).abandonDraft(id, reason);
    events.push({ type: "claim_draft_abandoned", data: { claimId: id, reason } });
  } catch (err) {
    events.push({ type: "claim_draft_abandon_failed", data: { claimId: id, error: err?.message } });
  }
}

/* ------------------------------------------------------------- entry */

export function purchaseInProgress(session) {
  const step = session?.currentStep;
  if (!step || isClaimStep(step)) return false;
  if (["welcome", "done"].includes(step)) return false;
  return session.status === undefined || session.status === null || session.status === "active";
}

/**
 * The customer asked to report a claim (menu row or keyword).
 * Applies the switch, the payment-pending refusal and the purchase-in-progress
 * confirmation (D7) before anything else.
 */
export async function startClaimJourney({ session, ctx, helpers = {}, events = [] }) {
  const t = translator(session.language);

  if (!access(ctx).allowed) {
    const replies = [textReply(t("claim.notAvailable", { number: numberSuffix(ctx, t) }))];
    if (session.currentStep && !isClaimStep(session.currentStep) && typeof helpers.renderPurchaseStep === "function") {
      replies.push(...(await helpers.renderPurchaseStep(session.currentStep, session)).replies);
    }
    return { replies, patch: {}, events: [...events, { type: "claim_unavailable" }], countsAsCustomerMessage: true };
  }

  if (session.currentStep === "payment_wait") {
    return {
      replies: [textReply(t("claim.paymentPending"), "payment_wait")],
      patch: {},
      events: [...events, { type: "claim_refused_payment_pending" }],
      countsAsCustomerMessage: true,
    };
  }

  if (purchaseInProgress(session)) {
    // Park the purchase now, so "No" can put it back exactly as it was.
    const parked = {
      currentStep: session.currentStep,
      stepHistory: session.stepHistory || [],
      collectedData: session.collectedData || {},
      parkedAt: (ctx.now || new Date()).toISOString(),
    };
    const rendered = await renderClaimStep("claim_switch_confirm", { ...session, collectedData: {} }, ctx);
    return {
      replies: rendered.replies,
      patch: { ...rendered.patch, parkedPurchase: parked, collectedData: {}, stepHistory: [], retryCount: 0, flowKey: "claim" },
      events,
      countsAsCustomerMessage: true,
    };
  }

  return beginClaim({ session: { ...session, collectedData: {} }, ctx, events, intro: true });
}

/** Offer to resume an unfinished draft, or go straight to identification. */
async function beginClaim({ session, ctx, events = [], intro = true, offerResume = true }) {
  const t = translator(session.language);
  const replies = intro ? [textReply(t("claim.intro"))] : [];

  if (offerResume && typeof deps(ctx).findResumableDraft === "function") {
    let offer = null;
    try {
      offer = await deps(ctx).findResumableDraft({ waNumber: session.waNumber, sessionId: session.id });
    } catch {
      offer = null;
    }
    if (offer?.claimId && offer.state?.policy) {
      const state = {
        resumeOffer: { claimId: offer.claimId, policyNumber: offer.state.policy.policyNumber, step: offer.step, state: offer.state },
      };
      return go("claim_resume", session, ctx, {
        state, history: [], events: [...events, { type: "claim_resume_offered", data: { claimId: offer.claimId } }],
      });
    }
  }

  return go("claim_identify", session, ctx, {
    state: {}, history: [], replies, events: [...events, { type: "claim_started" }], patch: { claimId: null },
  });
}

/** "SUIVI", with or without a reference. */
export async function startTrackJourney({ session, ctx, helpers = {}, reference = null, events = [] }) {
  const t = translator(session.language);
  if (!access(ctx).allowed) return startClaimJourney({ session, ctx, helpers, events });

  const step = session.currentStep;
  if (reference) {
    const replies = await trackReplies({ session, ctx, reference, t });
    // Tracking never disturbs what the customer was doing: re-ask its question.
    if (step && step !== "claim_closed" && step !== "claim_track") {
      const again = isClaimStep(step)
        ? await renderClaimStep(step, session, ctx)
        : typeof helpers.renderPurchaseStep === "function"
          ? await helpers.renderPurchaseStep(step, session)
          : { replies: [] };
      return { replies: [...replies, ...again.replies], patch: {}, events: [...events, { type: "claim_tracked" }], countsAsCustomerMessage: true };
    }
    return {
      replies: [...replies, textReply(t("claim.anythingElse"), "claim_closed")],
      patch: { currentStep: "claim_closed", flowKey: "claim", retryCount: 0 },
      events: [...events, { type: "claim_tracked" }],
      countsAsCustomerMessage: true,
    };
  }
  if (purchaseInProgress(session) || step === "payment_wait") {
    // Asking for a reference here would take over the purchase's question;
    // say how to ask in one message instead.
    return { replies: [textReply(t("claim.trackPrompt"))], patch: {}, events, countsAsCustomerMessage: true };
  }
  const rendered = await renderClaimStep("claim_track", session, ctx);
  return { replies: rendered.replies, patch: { ...rendered.patch, flowKey: "claim", retryCount: 0 }, events, countsAsCustomerMessage: true };
}

async function trackReplies({ session, ctx, reference, t }) {
  const l = lang(session);
  let found = null;
  try {
    found = await deps(ctx).trackClaim?.({ waNumber: session.waNumber, reference: normaliseIdentifier(reference) });
  } catch {
    found = null;
  }
  if (!found) return [textReply(t("claim.trackNotFound"), "claim_track")];
  return [
    textReply(t("claim.trackStatus", {
      reference: found.reference,
      category: (l === "en" ? found.categoryEn : found.categoryFr) || found.categoryFr || "",
      date: formatDate(found.submittedAt, l),
      status: t(`claim.status.${found.status}`, {}, found.status),
    }), "claim_track"),
  ];
}

/* -------------------------------------------------------------- parsing */

export function parseFieldAnswer(field, message, text, t) {
  const sel = message.selectionId || "";
  const skip = sel === "opt:__skip" || isWord(text, SKIP_WORDS);
  if (skip) {
    if (field.required) return { ok: false, error: t("claim.fieldRequired") };
    return { ok: true, value: null };
  }
  if (field.type === "choice") {
    const options = field.options || [];
    let hit = null;
    if (sel.startsWith("opt:")) hit = options.find((o) => String(o.value) === sel.slice(4));
    if (!hit && text) {
      const n = normalizeCommandText(text);
      hit = options.find((o) => [o.value, o.label_fr, o.label_en].some((x) => normalizeCommandText(x) === n))
        || (/^\d+$/.test(n) ? options[Number(n) - 1] : null);
    }
    return hit ? { ok: true, value: hit.value } : { ok: false, error: t("claim.fieldChoice") };
  }
  if (!text) return { ok: false, error: t("claim.fieldRequired") };
  if (field.type === "number") {
    const n = Number(String(text).replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(n)) return { ok: false, error: t("claim.fieldNumber") };
    const min = field.min ?? null;
    const max = field.max ?? null;
    if ((min !== null && n < min) || (max !== null && n > max)) {
      return { ok: false, error: t("claim.fieldRange", { min: min ?? "—", max: max ?? "—" }) };
    }
    return { ok: true, value: n };
  }
  if (field.type === "date") {
    const d = validateDateLoose(text);
    return d.ok ? { ok: true, value: d.value } : { ok: false, error: t("claim.dateInvalid") };
  }
  const max = Number(field.max_length) || 200;
  if (text.length > max) return { ok: false, error: t("claim.fieldTooLong", { max }) };
  return { ok: true, value: text };
}

/** Whole-word match of the admin's urgent keywords, accents ignored. */
export function detectUrgent(text, config = {}) {
  const kw = config.urgentKeywords || {};
  const list = [...(kw.fr || []), ...(kw.en || [])];
  if (!list.length) return false;
  const s = ` ${normalizeCommandText(text)} `;
  return list.some((k) => {
    const n = normalizeCommandText(k);
    return Boolean(n) && s.includes(` ${n} `);
  });
}

/** Required documents not yet received. Files are matched to a document type
 *  when the customer labels them (Day 5); until then any file counts. */
export function missingRequired(state) {
  const docs = state.documents || [];
  const got = new Set(docs.map((d) => d.type).filter(Boolean));
  const missing = (state.subcategory?.requiredDocuments || []).filter((d) => !got.has(d.code));
  const untyped = docs.filter((d) => !d.type).length;
  return missing.slice(Math.min(untyped, missing.length));
}

/* -------------------------------------------------------- the handler */

/**
 * A message while the session is in a claim step.
 * @param helpers { countryParser, renderPurchaseStep, sharedCommand, reenter, startPurchase, onClaimMedia }
 */
export async function processClaimMessage({ message, session, ctx, helpers = {} }) {
  const t = translator(session.language);
  const l = lang(session);
  const events = [];
  const rawText = String(message.text || "").trim();
  const sel = message.selectionId || "";
  const [stepKey] = String(session.currentStep).split(":");
  const state = claimState(session);

  /* --- switched off mid-journey: stop, honestly ------------------------ */
  if (!access(ctx).allowed && stepKey !== "claim_closed") {
    await abandonDraft(ctx, session, state, "claims_disabled", events);
    return leave(session, ctx, helpers, {
      replies: [textReply(t("claim.notAvailable", { number: numberSuffix(ctx, t) }))],
      events,
      patch: { claimId: null },
    });
  }

  /* --- a photo or a file (Day 5) ---------------------------------------- */
  // The controller has already fetched, checked and stored it before this
  // runs, and put the outcome on message.stored. Here: what to say.
  if (message.media) return handleMedia({ message, session, ctx, helpers, state, events, t, l, stepKey });

  /* --- "track SIN-…" works from anywhere but free-text answers --------- */
  // A tap carries its button's title as text; only typed text is read for
  // commands, or an English "Report a claim" button would mean CLAIM.
  const typed = sel ? "" : rawText;
  const track = parseTrackRequest(typed);
  if (track && !FREE_TEXT_STEPS.has(stepKey)) {
    return startTrackJourney({ session, ctx, helpers, reference: track.reference, events });
  }

  /* --- commands -------------------------------------------------------- */
  let command = detectCommandFromSelection(sel) || (typed ? detectCommand(typed) : null);
  // In free-text steps only short exact command words count; the loose
  // readings (certificate / claim / track sentences) are answers there.
  if (command && FREE_TEXT_STEPS.has(stepKey) && !sel) {
    const short = normalizeCommandText(rawText).split(" ").length <= 2;
    if ([COMMANDS.CERTIFICATE, COMMANDS.CLAIM, COMMANDS.TRACK].includes(command) || !short) command = null;
  }
  if (command) {
    const handled = await handleClaimCommand({ command, session, ctx, helpers, state, events });
    if (handled) return handled;
  }

  /* --- buttons that leave the claim ------------------------------------ */
  if (sel === "menu:buy") {
    await abandonDraft(ctx, session, state, "switched_to_purchase", events);
    if (session.parkedPurchase) return leave(session, ctx, helpers, { events, patch: { claimId: null } });
    if (typeof helpers.startPurchase === "function") {
      const started = await helpers.startPurchase({ ...session, currentStep: null, collectedData: {}, stepHistory: [] });
      return {
        ...started,
        patch: { stepHistory: [], collectedData: {}, ...started.patch, claimId: null, parkedPurchase: null, flowKey: "purchase" },
        events: [...events, ...(started.events || [])],
      };
    }
  }
  if (sel === "menu:claim") return startClaimJourney({ session: { ...session, currentStep: null }, ctx, helpers, events });
  if (sel === "menu:track") return startTrackJourney({ session: { ...session, currentStep: null }, ctx, helpers, events });

  /* --- resting: anything else opens the main conversation -------------- */
  if (stepKey === "claim_closed") {
    if (typeof helpers.reenter === "function") {
      return helpers.reenter({ ...session, currentStep: null, collectedData: {}, stepHistory: [], retryCount: 0 });
    }
    return leave(session, ctx, helpers, { events });
  }

  const retry = async (errorText) => {
    const retryCount = (session.retryCount || 0) + 1;
    const replies = [textReply(errorText, stepKey)];
    if (retryCount >= MAX_RETRIES && ctx.config?.escalationNumber) {
      replies.push(textReply(t("agent.withNumber", { number: ctx.config.escalationNumber })));
    }
    if (retryCount === 1 || retryCount >= MAX_RETRIES || stepKey !== "claim_description") {
      const again = await renderClaimStep(session.currentStep, session, ctx);
      replies.push(...again.replies);
    }
    return { replies, patch: { retryCount: retryCount >= MAX_RETRIES ? 0 : retryCount }, events, countsAsCustomerMessage: true };
  };

  switch (stepKey) {
    /* ----------------------------------------------- D7: confirm switch */
    case "claim_switch_confirm": {
      if (sel === "claim:switch_yes" || isWord(rawText, YES_WORDS)) {
        return beginClaim({ session: { ...session, collectedData: {} }, ctx, events, intro: true });
      }
      if (sel === "claim:switch_no" || isWord(rawText, NO_WORDS)) {
        return leave(session, ctx, helpers, { events, patch: { claimId: null } });
      }
      return retry(t("error.generic"));
    }

    /* ------------------------------------------------------------ resume */
    case "claim_resume": {
      const offer = state.resumeOffer || {};
      if (sel === "claim:resume_yes" || isWord(rawText, [...YES_WORDS, "reprendre", "resume"])) {
        const restored = { ...(offer.state || {}), claimId: offer.claimId };
        delete restored.returnTo;
        delete restored.resumeOffer;
        const raw = isClaimStep(offer.step) ? offer.step : "claim_category";
        const step = IDENTIFY_STEPS.has(raw.split(":")[0]) || ["claim_closed", "claim_track", "claim_resume", "claim_switch_confirm"].includes(raw.split(":")[0])
          ? "claim_category"
          : raw;
        if (step.startsWith("claim_field:")) restored.fieldIdx = Number(step.split(":")[1]);
        return go(step, session, ctx, {
          state: restored,
          history: [],
          events: [...events, { type: "claim_resumed", data: { claimId: offer.claimId } }],
          patch: { claimId: offer.claimId },
        });
      }
      if (sel === "claim:resume_no" || isWord(rawText, [...NO_WORDS, "nouvelle declaration", "new claim"])) {
        await abandonDraft(ctx, session, { claimId: offer.claimId }, "replaced_by_new_claim", events);
        return beginClaim({ session: { ...session, collectedData: {} }, ctx, events, intro: false, offerResume: false });
      }
      return retry(t("error.generic"));
    }

    /* --------------------------------------------------- identification */
    case "claim_identify": {
      const id = normaliseIdentifier(rawText);
      if (id.length < 4 || id.length > 60 || !/\d/.test(id)) return retry(t("claim.identifierInvalid"));
      return go("claim_passport", session, ctx, { state: { identifier: id }, history: ["claim_identify"], events });
    }

    case "claim_passport": {
      if (!rawText) return retry(t("claim.identifierInvalid"));
      const validate = deps(ctx).validatePolicy;
      if (typeof validate !== "function") return { replies: [textReply(t("system.error"))], patch: {}, events, countsAsCustomerMessage: true };
      let result;
      try {
        result = await validate({ waNumber: session.waNumber, sessionId: session.id, identifier: state.identifier, passport: rawText });
      } catch (err) {
        events.push({ type: "claim_validation_error", data: { error: err?.message } });
        return { replies: [textReply(t("system.error"))], patch: {}, events, countsAsCustomerMessage: true };
      }
      return handleValidation({ result, session, ctx, helpers, events, t, l });
    }

    case "claim_policy_confirm": {
      if (sel === "claim:policy_no" || isWord(rawText, NO_WORDS)) {
        return go("claim_identify", session, ctx, { state: {}, history: [], events });
      }
      if (!(sel === "claim:policy_yes" || isWord(rawText, [...YES_WORDS, "c est elle"]))) return retry(t("error.generic"));
      const policy = state.policy || {};
      const isTest = Boolean(policy.isTest || access(ctx).allowlisted);
      let claimId = null;
      try {
        claimId = await deps(ctx).createDraft?.({
          waNumber: session.waNumber, sessionId: session.id, language: l, policy, isTest, flags: state.flags || [],
        });
      } catch (err) {
        events.push({ type: "claim_draft_create_failed", data: { error: err?.message } });
        return { replies: [textReply(t("system.error"))], patch: {}, events, countsAsCustomerMessage: true };
      }
      const next = { ...state, claimId: claimId || null, isTest };
      delete next.identifier;
      // The identification steps are behind us: BACK starts from here.
      return go("claim_category", session, ctx, {
        state: next,
        history: [],
        events: [...events, { type: "claim_draft_created", data: { claimId, isTest } }],
        patch: { claimId: claimId || null },
      });
    }

    /* ------------------------------------------------------- categories */
    case "claim_category": {
      const tree = await categoryTree(ctx);
      let hit = sel.startsWith("cat:") ? tree.find((c) => c.code === sel.slice(4)) : null;
      if (!hit && rawText) {
        const n = normalizeCommandText(rawText);
        hit = tree.find((c) => [c.nameFr, c.nameEn, c.code].some((x) => normalizeCommandText(x) === n))
          || (/^\d+$/.test(n) ? tree[Number(n) - 1] : null);
      }
      if (!hit) return retry(t("claim.fieldChoice"));
      return advance("claim_category", session, ctx, { ...state, category: { code: hit.code, nameFr: hit.nameFr, nameEn: hit.nameEn } }, { events });
    }

    case "claim_subcategory": {
      const tree = await categoryTree(ctx);
      const parent = tree.find((c) => c.code === state.category?.code);
      if (!parent) return go("claim_category", session, ctx, { state, events });
      let hit = sel.startsWith("sub:") ? parent.children.find((c) => c.code === sel.slice(4)) : null;
      if (!hit && rawText) {
        const n = normalizeCommandText(rawText);
        hit = parent.children.find((c) => [c.nameFr, c.nameEn, c.code].some((x) => normalizeCommandText(x) === n))
          || (/^\d+$/.test(n) ? parent.children[Number(n) - 1] : null);
      }
      if (!hit) return retry(t("claim.fieldChoice"));

      const coverage = checkCoverage(state.policy?.guaranteeCodes, hit.guaranteeCodes, { config: cfg(ctx) });
      if (!coverage.ok) {
        return go("claim_category", session, ctx, {
          state,
          replies: [textReply(t("claim.uncovered", { plan: state.policy?.planName || "" }))],
          events: [...events, { type: "claim_uncovered_refused", data: { subcategory: hit.code } }],
        });
      }
      const changed = Boolean(state.subcategory?.code && state.subcategory.code !== hit.code);
      let flags = (state.flags || []).filter((f) => f !== "uncovered_claim_type");
      if (coverage.flag) flags = [...new Set([...flags, coverage.flag])];
      const keepUrgent = (state.flags || []).includes("urgent_keywords");
      const next = {
        ...state,
        subcategory: subSnapshot(hit),
        flags,
        priority: keepUrgent ? "urgent" : hit.defaultPriority || "normal",
      };
      if (changed) {
        next.fields = {};
        next.subChanged = true;
      }
      return advance("claim_subcategory", session, ctx, next, { events });
    }

    /* ------------------------------------------------------ the incident */
    case "claim_incident_date": {
      const parsed = validateDateLoose(rawText);
      if (!parsed.ok) return retry(t("claim.dateInvalid"));
      const check = checkIncidentDate(state.policy || {}, parsed.value, { today: ctx.now || new Date(), config: cfg(ctx) });
      if (!check.ok) {
        if (check.reason === "future") return retry(t("claim.dateFuture"));
        if (check.reason === "invalid") return retry(t("claim.dateInvalid"));
        if (check.reason === "out_of_window") {
          events.push({ type: "claim_date_out_of_window" });
          return retry(t("claim.dateOutOfWindow", { days: check.windowDays, number: numberSuffix(ctx, t) }));
        }
        // Outside cover: say so, offer the two ways forward, and stay on the
        // step so a mistyped date can simply be sent again.
        return {
          replies: [buttonsReply(
            t("claim.dateOutsideCover", { start: formatDate(check.startDate, l), end: formatDate(check.endDate, l) }),
            [{ id: "menu:buy", title: t("claim.buyButton") }, { id: "cmd:agent", title: t("claim.agentButton") }],
            "claim_incident_date"
          )],
          patch: { retryCount: 0 },
          events: [...events, { type: "claim_date_outside_cover", data: { reason: check.reason } }],
          countsAsCustomerMessage: true,
        };
      }
      return advance("claim_incident_date", session, ctx, { ...state, incidentDate: parsed.value }, { events });
    }

    case "claim_country": {
      if (typeof helpers.countryParser !== "function") return retry(t("system.error"));
      const pseudoStep = {
        key: "claim_country",
        stores: ["incident_country", "incident_country_code"],
        candidatesKey: "claim.countryCandidates",
        listPromptKey: "claim.countryPrompt",
        listButtonKey: "claim.listButton",
      };
      const parsed = await helpers.countryParser({ message, text: rawText, step: pseudoStep, ctx, session, t });
      if (parsed.ok) {
        const code = parsed.stores.incident_country_code;
        let label = parsed.stores.incident_country;
        try {
          const c = await ctx.deps?.getCountryByCode?.(code);
          if (c) label = (l === "en" ? c.name_en : c.name_fr) || label;
        } catch { /* the English name is fine */ }
        return advance("claim_country", session, ctx, {
          ...state, country: parsed.stores.incident_country, countryCode: code, countryLabel: label,
        }, { events });
      }
      if (parsed.handled) {
        const patch = {};
        if (parsed.countsAsRetry) patch.retryCount = (session.retryCount || 0) + 1;
        return { replies: parsed.replies || [], patch, events, countsAsCustomerMessage: true };
      }
      return retry(parsed.message || t("error.generic"));
    }

    case "claim_city": {
      const city = rawText.replace(/\s+/g, " ");
      if (city.length < 2 || city.length > 80 || /^\d+$/.test(city)) return retry(t("claim.cityInvalid"));
      return advance("claim_city", session, ctx, { ...state, city }, { events });
    }

    case "claim_field": {
      const rawIdx = String(session.currentStep).split(":")[1];
      const idx = Number(rawIdx ?? state.fieldIdx ?? 0);
      const field = fieldsOf(state)[idx];
      if (!field) return advance(`claim_field:${idx}`, session, ctx, state, { events });
      const parsed = parseFieldAnswer(field, message, rawText, t);
      if (!parsed.ok) return retry(parsed.error);
      const fields = { ...(state.fields || {}), [field.key]: parsed.value };
      return advance(`claim_field:${idx}`, session, ctx, { ...state, fields, fieldIdx: idx }, { events });
    }

    case "claim_description": {
      const min = Number(cfg(ctx).descriptionMin) || 20;
      const max = Number(cfg(ctx).descriptionMax) || 1500;
      const text = rawText.replace(/[ \t]+/g, " ");
      if (text.length < min) return retry(t("claim.descriptionTooShort", { count: text.length, min }));
      if (text.length > max) return retry(t("claim.descriptionTooLong", { count: text.length, max }));
      let next = { ...state, description: text };
      const replies = [];
      if (detectUrgent(text, cfg(ctx))) {
        if (state.priority !== "urgent") events.push({ type: "claim_urgent_detected", data: { claimId: state.claimId || session.claimId } });
        next = { ...next, priority: "urgent", flags: addFlag(next, "urgent_keywords") };
        const number = ctx.config?.escalationNumber;
        replies.push(textReply(number ? t("claim.urgentNumber", { number }) : t("claim.urgent")));
      }
      return advance("claim_description", session, ctx, next, { replies, events });
    }

    /* -------------------------------------------------------- documents */
    case "claim_documents": {
      if (message.type === "media" && typeof helpers.onClaimMedia === "function") {
        return helpers.onClaimMedia({ message, session, ctx, state, events });
      }
      if (sel === "claim:docs_done" || isWord(rawText, DONE_WORDS)) {
        const missing = missingRequired(state);
        if (missing.length) {
          return {
            replies: [buttonsReply(
              t("claim.documentsMissing", { list: missing.map((d) => `• ${labelOf(d, l)}`).join("\n") }),
              [{ id: "claim:docs_later", title: t("claim.documentsLaterButton") }],
              "claim_documents"
            )],
            patch: {},
            events,
            countsAsCustomerMessage: true,
          };
        }
        return advance("claim_documents", session, ctx, state, { events });
      }
      if (sel === "claim:docs_later" || isWord(rawText, LATER_WORDS)) {
        const flags = missingRequired(state).length ? addFlag(state, "documents_incomplete") : state.flags || [];
        return advance("claim_documents", session, ctx, { ...state, flags }, { events });
      }
      return { replies: [textReply(t("claim.documentsWaiting"), "claim_documents")], patch: {}, events, countsAsCustomerMessage: true };
    }

    /* ----------------------------------------------------------- review */
    case "claim_review": {
      if (sel === "claim:modify" || isWord(rawText, ["modifier", "change", "edit"])) {
        return go("claim_edit", session, ctx, { state, events });
      }
      if (sel === "claim:cancel") return cancelClaim({ session, ctx, helpers, state, events, t });
      if (sel === "claim:submit" || isWord(rawText, ["envoyer", "submit", "valider", "confirmer", "confirm", "send"])) {
        if (consentText(ctx, l) && !state.consentAcceptedAt) return go("claim_consent", session, ctx, { state, events });
        return submit({ session, ctx, helpers, state, events, t, l });
      }
      return retry(t("error.generic"));
    }

    case "claim_edit": {
      const target = {
        "edit:type": "claim_category",
        "edit:date": "claim_incident_date",
        "edit:place": "claim_country",
        "edit:details": "claim_field:0",
        "edit:description": "claim_description",
        "edit:documents": "claim_documents",
      }[sel];
      if (!target) return retry(t("claim.fieldChoice"));
      const next = { ...state, returnTo: "claim_review" };
      if (target === "claim_field:0") next.fieldIdx = 0;
      return go(target, session, ctx, { state: next, events });
    }

    case "claim_consent": {
      if (sel === "claim:consent_yes" || isWord(rawText, [...YES_WORDS, "j accepte", "i accept", "accepte", "accept"])) {
        const next = { ...state, consentAcceptedAt: (ctx.now || new Date()).toISOString() };
        return submit({ session, ctx, helpers, state: next, events, t, l });
      }
      if (sel === "claim:consent_no" || isWord(rawText, [...NO_WORDS, "je refuse", "refuse", "decline"])) {
        return go("claim_review", session, ctx, {
          state, replies: [textReply(t("claim.consentDeclined"))], events: [...events, { type: "claim_consent_declined" }],
        });
      }
      return retry(t("error.generic"));
    }

    /* ------------------------------------------------------------ track */
    case "claim_track": {
      const ref = parseTrackRequest(rawText)?.reference || normaliseIdentifier(rawText);
      if (!ref || ref.length < 4) return retry(t("claim.trackPrompt"));
      const replies = await trackReplies({ session, ctx, reference: ref, t });
      const notFound = replies[0]?.body === t("claim.trackNotFound");
      if (notFound && (session.retryCount || 0) + 1 < MAX_RETRIES) {
        return { replies, patch: { retryCount: (session.retryCount || 0) + 1 }, events, countsAsCustomerMessage: true };
      }
      return {
        replies: [...replies, textReply(t("claim.anythingElse"), "claim_closed")],
        patch: { currentStep: "claim_closed", retryCount: 0 },
        events: [...events, { type: "claim_tracked", data: { found: !notFound } }],
        countsAsCustomerMessage: true,
      };
    }

    default:
      return go("claim_identify", session, ctx, { state: {}, history: [], events });
  }
}

async function handleMedia({ message, session, ctx, state, events, t, l, stepKey }) {
  const stored = message.stored || { ok: false, code: "not_processed" };
  const reask = async (replies) => {
    if (stepKey === "claim_closed" || stepKey === "claim_documents") return replies;
    const again = await renderClaimStep(session.currentStep, session, ctx);
    return [...replies, ...again.replies];
  };
  const done = [{ id: "claim:docs_done", title: t("claim.documentsDoneButton") }];

  if (!stored.ok) {
    const max = Number(cfg(ctx).maxFileMb) || 10;
    const key = {
      no_claim: "claim.documentTooEarly",
      too_many: "claim.documentTooMany",
      too_large: "claim.documentTooLarge",
      bad_type: "claim.documentBadType",
      corrupted: "claim.documentCorrupted",
      hash_mismatch: "claim.documentCorrupted",
      empty: "claim.documentCorrupted",
    }[stored.code] || "claim.documentFailed";
    const body = t(key, { max: stored.code === "too_many" ? stored.max || cfg(ctx).maxDocuments || 10 : max });
    const reply = stored.code === "too_many" && stepKey === "claim_documents"
      ? buttonsReply(body, done, "claim_documents")
      : textReply(body, stepKey);
    return {
      replies: await reask([reply]),
      patch: {},
      events: [...events, { type: "claim_document_rejected", data: { code: stored.code } }],
      countsAsCustomerMessage: true,
    };
  }

  const docs = [...(state.documents || [])];
  if (stored.documentId && !docs.some((d) => d.id === stored.documentId)) {
    docs.push({ id: stored.documentId, status: stored.status || "stored", name: message.media?.filename || null });
  }
  const next = { ...state, documents: docs };
  const count = stored.count ?? docs.length;
  const name = message.media?.filename || (message.media?.kind === "image" ? (l === "en" ? "photo" : "photo") : "document");

  let replies;
  if (stepKey === "claim_documents") {
    const body = stored.status === "pending" ? t("claim.documentPending", { count }) : t("claim.documentReceived", { name, count });
    replies = [buttonsReply(body, done, "claim_documents")];
  } else {
    // A file at the wrong moment is not refused: it is attached, and the
    // question that was open is asked again.
    replies = await reask([textReply(t("claim.documentAttached"), stepKey)]);
  }
  return {
    replies,
    patch: { collectedData: withState(next) },
    events: [...events, { type: "claim_document_received", data: { documentId: stored.documentId, status: stored.status, duplicate: Boolean(stored.duplicate) } }],
    countsAsCustomerMessage: true,
  };
}

async function handleValidation({ result, session, ctx, helpers, events, t, l }) {
  const p = result?.policy || {};
  const number = numberSuffix(ctx, t);
  const closeWith = (body, extraEvents = [], buttons = null) =>
    leave(session, ctx, helpers, {
      replies: [buttons ? buttonsReply(body, buttons) : textReply(body)],
      events: [...events, ...extraEvents],
      patch: { claimId: null },
    });

  if (result?.ok) {
    return go("claim_policy_confirm", session, ctx, {
      state: { policy: result.session, flags: result.flags || [] },
      history: ["claim_identify", "claim_passport"],
      events: [...events, { type: "claim_policy_validated", data: { source: result.session?.source } }],
    });
  }

  switch (result?.outcome) {
    case "not_found": {
      const left = Number(result.attemptsLeft ?? 0);
      if (left <= 0) {
        return closeWith(t("claim.locked", { minutes: cfg(ctx).lockoutMinutes || 30, number }), [{ type: "claim_validation_locked" }]);
      }
      return go("claim_identify", session, ctx, {
        state: {}, history: [], replies: [textReply(t("claim.notFound", { left }))],
        events: [...events, { type: "claim_validation_failed" }],
      });
    }
    case "locked":
      return closeWith(t("claim.locked", { minutes: result.retryAfterMinutes || cfg(ctx).lockoutMinutes || 30, number }), [{ type: "claim_validation_locked" }]);
    case "expired":
      return closeWith(
        t("claim.expired", { policy: p.policyNumber || "", date: formatDate(result.endDate || p.endDate, l) }),
        [{ type: "claim_policy_expired" }],
        [{ id: "menu:buy", title: t("claim.buyButton") }, { id: "cmd:agent", title: t("claim.agentButton") }]
      );
    case "cancelled":
      // An adviser is told: someone holding a cancelled policy has an incident.
      return closeWith(t("claim.cancelledPolicy", { policy: p.policyNumber || "", number }), [
        { type: "claim_agent_flag", data: { reason: "cancelled_policy", policyNumber: p.policyNumber } },
      ]);
    case "unpaid":
      return closeWith(t("claim.unpaid", { policy: p.policyNumber || "", number }), [
        { type: "claim_agent_flag", data: { reason: "unpaid_policy", policyNumber: p.policyNumber } },
      ]);
    case "out_of_window":
      return closeWith(t("claim.outOfWindow", { policy: p.policyNumber || "", days: result.windowDays || "", number }), [{ type: "claim_out_of_window" }]);
    case "not_started":
      return closeWith(t("claim.notStarted", { policy: p.policyNumber || "", date: formatDate(result.startDate || p.startDate, l) }));
    case "no_dates":
      return closeWith(t("claim.noDates", { policy: p.policyNumber || "", number }), [
        { type: "claim_agent_flag", data: { reason: "no_dates", policyNumber: p.policyNumber } },
      ]);
    default:
      return { replies: [textReply(t("system.error"))], patch: {}, events, countsAsCustomerMessage: true };
  }
}

async function cancelClaim({ session, ctx, helpers, state, events, t }) {
  await abandonDraft(ctx, session, state, "cancelled_by_customer", events);
  return leave(session, ctx, helpers, {
    replies: [textReply(t("claim.cancelled"))],
    events: [...events, { type: "claim_cancelled" }],
    patch: { claimId: null },
  });
}

async function submit({ session, ctx, helpers, state, events, t, l }) {
  const claimId = state.claimId || session.claimId;
  let result = null;
  try {
    result = await deps(ctx).submitClaim?.({ claimId, state, language: l, waNumber: session.waNumber });
  } catch (err) {
    events.push({ type: "claim_submit_error", data: { claimId, error: err?.message } });
    result = null;
  }
  if (!result?.ok || !result.reference) {
    // Nothing is lost: the draft and the session both still hold everything.
    return go("claim_review", session, ctx, {
      state,
      replies: [textReply(t("claim.submitFailed"))],
      events: [...events, { type: "claim_submit_failed", data: { claimId, reason: result?.reason || "unknown" } }],
    });
  }
  const custom = String((cfg(ctx).confirmationText || {})[l] || "").trim();
  const body = custom
    ? custom.replace(/\{\{\s*reference\s*\}\}/g, result.reference)
    : t("claim.submitted", { reference: result.reference });
  return leave(session, ctx, helpers, {
    replies: [textReply(body, "claim_submitted")],
    events: [...events, { type: "claim_submitted", data: { claimId, reference: result.reference, priority: state.priority || "normal" } }],
  });
}

async function handleClaimCommand({ command, session, ctx, helpers, state, events }) {
  const t = translator(session.language);
  const [stepKey] = String(session.currentStep).split(":");
  const resting = stepKey === "claim_closed";

  if (command === COMMANDS.HELP) {
    const again = resting ? { replies: [] } : await renderClaimStep(session.currentStep, session, ctx);
    return { replies: [textReply(t("claim.help")), ...again.replies], patch: {}, events, countsAsCustomerMessage: true };
  }

  if (command === COMMANDS.RESTART) {
    if (resting || stepKey === "claim_track") return null; // the purchase meaning applies
    // Restarts THIS journey. A parked purchase stays parked.
    await abandonDraft(ctx, session, state, "restarted_by_customer", events);
    return go("claim_identify", session, ctx, {
      state: {}, history: [], replies: [textReply(t("claim.restarted"))],
      events: [...events, { type: "claim_restarted" }], patch: { claimId: null },
    });
  }

  if (command === COMMANDS.CANCEL) {
    if (resting || stepKey === "claim_track") return null;
    return cancelClaim({ session, ctx, helpers, state, events, t });
  }

  if (command === COMMANDS.BACK) {
    if (resting) return null;
    const history = [...(session.stepHistory || [])];
    const previous = history.pop();
    // Never across into the purchase, and never back into identification
    // once the draft exists.
    const hasDraft = Boolean(state.claimId || session.claimId);
    if (!previous || !isClaimStep(previous) || (IDENTIFY_STEPS.has(previous.split(":")[0]) && hasDraft)) {
      const again = await renderClaimStep(session.currentStep, session, ctx);
      return { replies: [textReply(t("claim.noPrevious")), ...again.replies], patch: {}, events, countsAsCustomerMessage: true };
    }
    const next = { ...state };
    delete next.returnTo;
    if (previous.startsWith("claim_field:")) next.fieldIdx = Number(previous.split(":")[1]);
    return go(previous, session, ctx, { state: next, history, events });
  }

  const language = languageForCommand(command);
  if (language) {
    const switched = { ...session, language };
    const again = resting ? { replies: [] } : await renderClaimStep(session.currentStep, switched, ctx);
    return {
      replies: [textReply(translator(language)("language.switched")), ...again.replies],
      patch: { language },
      events,
      countsAsCustomerMessage: true,
    };
  }

  if (command === COMMANDS.CLAIM) {
    if (resting || stepKey === "claim_track") {
      return startClaimJourney({ session: { ...session, currentStep: null, collectedData: {} }, ctx, helpers, events });
    }
    const again = await renderClaimStep(session.currentStep, session, ctx);
    return { replies: again.replies, patch: {}, events, countsAsCustomerMessage: true };
  }

  if (command === COMMANDS.TRACK) {
    return startTrackJourney({ session: resting ? { ...session, currentStep: null } : session, ctx, helpers, events });
  }

  // AGENT and CERTIFICATE behave exactly as in the purchase journey.
  if (typeof helpers.sharedCommand === "function") {
    const shared = await helpers.sharedCommand(command, session);
    if (shared) {
      if (!resting && command === COMMANDS.AGENT) {
        const again = await renderClaimStep(session.currentStep, session, ctx);
        return { ...shared, replies: [...shared.replies.slice(0, 1), ...again.replies] };
      }
      return shared;
    }
  }
  return null;
}

export const __testables = { nextAfter, parseFieldAnswer, detectUrgent, missingRequired, purchaseInProgress, subSnapshot };
