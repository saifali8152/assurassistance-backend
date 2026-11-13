// controllers/simulatorController.js
//
// Milestone 5, Day 12 — the WhatsApp simulator (D11).
//
// An admin-only chat in the panel that drives the REAL conversation engine —
// same flow, same claim journey, same validation, same database for claims —
// with a test number, so the whole thing can be tested and accepted before
// Meta is connected.
//
// WHAT IT NEVER DOES
//   * send anything to WhatsApp — replies come back to the browser only;
//   * start a real payment — payment is off inside the simulator;
//   * write a quote, case or traveller — the purchase journey's last step is
//     answered with a simulated reference instead of persistQuote;
//   * send a certificate — that side effect is not run here.
// What it DOES write: the simulator's own session and transcript (marked
// simulated), and claims — which are test claims (D14), hidden by default.
//
// Claims are available in the simulator even while the switch is off: the
// simulator number counts as allowlisted. That is the point of it.
//
import { processMessage } from "../utils/whatsapp/engine.js";
import { getWhatsAppConfig, getClaimsConfig } from "../utils/appSettings.js";
import {
  getActiveSession, createSession, updateSession, closeSession, incrementCustomerMessageCount,
  recordInboundMessage, recordOutboundMessage, withNumberLock,
} from "../models/whatsappModel.js";
import { getCountries, getDestinations, getCountryByCode } from "../utils/referenceData.js";
import { listWhatsAppPlans } from "../models/quoteModel.js";
import { claimsContextFor, loadFlow } from "./whatsappController.js";
import { ingestDocument } from "../models/claimDocumentModel.js";
import { isClaimStep } from "../utils/whatsapp/claimEngine.js";
import { isFlagEnabled, CLAIMS_FLAG } from "../utils/featureFlags.js";
import { logAudit } from "../utils/adminAudit.js";

/** Simulator numbers start 999 — no real country code does — so they can never be a customer's. */
export const SIM_PREFIX = "999";
export function simulatorNumber(userId, suffix = "") {
  const tail = String(suffix || "").replace(/\D/g, "").slice(0, 4);
  return `${SIM_PREFIX}${String(userId).padStart(6, "0")}${tail}`.slice(0, 15);
}
const isSimNumber = (n) => String(n || "").startsWith(SIM_PREFIX);

const fail = (res, status, code, message) => res.status(status).json({ ok: false, code, message });

async function simulatorContext(waNumber) {
  // Allowlisted by construction: the simulator sees claims as a tester would.
  const enabled = await isFlagEnabled(CLAIMS_FLAG).catch(() => false);
  const [config, claims] = await Promise.all([
    getWhatsAppConfig(),
    claimsContextFor(waNumber, { forceAccess: { enabled, allowlisted: true, allowed: true } }),
  ]);
  return {
    config: { ...config, defaultLanguage: config.defaultLanguage || "fr" },
    ctx: {
      flow: await loadFlow(),
      config,
      payment: { enabled: false, options: [] },
      claims,
      now: new Date(),
      deps: {
        getCountries,
        getDestinations,
        getCountryByCode,
        getPlans: listWhatsAppPlans,
        findIssuedPolicy: async () => null,
        startPayment: async () => ({ ok: false, reason: "simulator" }),
        // Nothing is written to cases or travellers from the simulator.
        persistQuote: async () => ({ ok: true, quoteReference: `SIM-${Date.now().toString(36).toUpperCase()}`, caseId: null, travellerId: null }),
      },
    },
  };
}

export const getInfo = async (req, res) => {
  const waNumber = simulatorNumber(req.user.id, req.query.suffix);
  const session = await getActiveSession(waNumber);
  res.json({
    waNumber,
    session: session ? { id: session.id, step: session.currentStep, language: session.language, flow: session.flowKey, claimId: session.claimId ?? null } : null,
    claimsActiveForPublic: await isFlagEnabled(CLAIMS_FLAG).catch(() => false),
  });
};

export const postReset = async (req, res) => {
  const waNumber = simulatorNumber(req.user.id, req.body?.suffix);
  const session = await getActiveSession(waNumber);
  if (session) await closeSession(session.id, "cancelled");
  res.json({ ok: true, waNumber });
};

/**
 * One customer message. Body: { text } or { selectionId, selectionTitle }
 * or { file: { name, mime, base64 } }, plus optional { language, suffix }.
 * Returns the engine's replies, as WhatsApp would have shown them.
 */
export const postMessage = async (req, res) => {
  const waNumber = simulatorNumber(req.user.id, req.body?.suffix);
  if (!isSimNumber(waNumber)) return fail(res, 400, "not_a_test_number", "Simulator numbers only");
  const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 3000) : null;
  const selectionId = typeof req.body?.selectionId === "string" ? req.body.selectionId.slice(0, 200) : null;
  const file = req.body?.file && typeof req.body.file.base64 === "string" ? req.body.file : null;
  if (!text && !selectionId && !file) return fail(res, 400, "empty", "Send text, a button/list choice or a file");

  const result = await withNumberLock(waNumber, async () => {
    const { config, ctx } = await simulatorContext(waNumber);
    let session = await getActiveSession(waNumber);
    if (!session) {
      session = await createSession({ waNumber, profileName: req.user.name || "Simulator", language: req.body?.language === "en" ? "en" : config.defaultLanguage, timeoutHours: config.sessionTimeoutHours || 24 });
    }

    const waMessageId = `sim.${waNumber}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const message = {
      waMessageId,
      from: waNumber,
      profileName: "Simulator",
      timestamp: new Date(),
      rawType: file ? (String(file.mime || "").startsWith("image/") ? "image" : "document") : selectionId ? "interactive" : "text",
      type: file ? "unsupported" : selectionId ? "selection" : "text",
      text: selectionId ? (req.body?.selectionTitle || selectionId) : text,
      selectionId,
      selectionTitle: req.body?.selectionTitle || null,
    };
    if (file) {
      const kind = String(file.mime || "").startsWith("image/") ? "image" : "document";
      message.unsupportedKind = kind;
      message.text = null;
      message.media = { kind, id: null, mimeType: file.mime || null, sha256: null, filename: file.name || null, caption: null };
      let buffer = null;
      try {
        buffer = Buffer.from(file.base64, "base64");
      } catch {
        buffer = null;
      }
      if (isClaimStep(session.currentStep) && ctx.claims.access.allowed) {
        message.stored = !session.claimId
          ? { ok: false, code: "no_claim" }
          : await ingestDocument({
            claimId: session.claimId, waMessageId, buffer, declaredMime: file.mime, filename: file.name,
            waConfig: config, claimsConfig: ctx.claims.config,
          }).catch(() => ({ ok: false, code: "download_failed" }));
      }
    }

    await recordInboundMessage({
      sessionId: session.id, waNumber, waMessageId, messageType: message.rawType,
      body: file ? `[${file.name || "file"}]` : message.text, payload: { simulated: true }, stepKey: session.currentStep,
    }).catch(() => {});

    const out = await processMessage({ message, session, ctx });
    if (Object.keys(out.patch || {}).length) await updateSession(session.id, { ...out.patch, timeoutHours: config.sessionTimeoutHours || 24 });
    if (out.countsAsCustomerMessage) await incrementCustomerMessageCount(session.id);
    for (const reply of out.replies || []) {
      await recordOutboundMessage({
        sessionId: session.id, waNumber, messageType: reply.kind, body: reply.body,
        payload: { simulated: true, buttons: reply.buttons || null, sections: reply.sections || null }, stepKey: reply.stepKey, status: "simulated",
      }).catch(() => {});
    }
    const after = await getActiveSession(waNumber);
    return {
      replies: out.replies,
      events: (out.events || []).map((e) => ({ type: e.type })),
      session: after ? { id: after.id, step: after.currentStep, language: after.language, flow: after.flowKey, claimId: after.claimId ?? null } : null,
    };
  });

  if (!result.ran) return fail(res, 409, "busy", "The previous message is still being processed");
  await logAudit(req, "simulator.message", { entity: "simulator", entityId: waNumber, detail: { kind: file ? "file" : selectionId ? "selection" : "text" } });
  res.json({ ok: true, waNumber, ...result.result });
};

export const __testables = { simulatorNumber, isSimNumber };
