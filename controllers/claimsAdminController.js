// controllers/claimsAdminController.js
//
// Milestone 5, Days 11–12 — the claims section of the admin panel:
// list, detail, status, documents, settings, categories, activation, allowlist.
//
// Every endpoint is gated by a permission (routes/claimsAdminRoutes.js) and
// every sensitive view or change is written to admin_audit_log.
//
import { listClaims, claimsSummary, getClaimDetail, signDocumentLink, verifyDocumentLink, LINK_TTL_SECONDS } from "../models/claimAdminModel.js";
import { transition } from "../models/claimModel.js";
import { getDocument } from "../models/claimDocumentModel.js";
import { readDecrypted } from "../utils/claims/documentStore.js";
import { STAFF_TARGETS } from "../utils/claims/stateMachine.js";
import { listAllCategories, validateCategoryInput, createCategory, updateCategory, invalidateCategories } from "../models/claimCategoryModel.js";
import {
  CLAIMS_FLAG, getFlag, setFlag, listAllowlist, addToAllowlist, removeFromAllowlist, listFlagAudit, clearFlagCache,
} from "../utils/featureFlags.js";
import { SETTING_REGISTRY, validateSettingValue, saveSettings, getSettingRows } from "../models/settingsModel.js";
import { loadSettings, invalidateSettings } from "../utils/appSettings.js";
import { logAudit } from "../utils/adminAudit.js";

const fail = (res, status, code, message, extra = {}) => res.status(status).json({ ok: false, code, message, ...extra });

/* ----------------------------------------------------------------- list */

export const getClaims = async (req, res) => {
  try {
    const result = await listClaims({
      status: req.query.status || null,
      priority: req.query.priority || null,
      category: req.query.category || null,
      q: req.query.q || "",
      includeTest: req.query.includeTest === "1" || req.query.includeTest === "true",
      from: req.query.from || null,
      to: req.query.to || null,
      page: req.query.page,
      limit: req.query.limit,
    });
    const flag = await getFlag(CLAIMS_FLAG).catch(() => null);
    res.json({ ...result, active: Boolean(flag?.enabled) });
  } catch (err) {
    console.error("claims admin: list", err);
    fail(res, 500, "claims_list_failed", "Could not load claims");
  }
};

export const getSummary = async (_req, res) => {
  try {
    const flag = await getFlag(CLAIMS_FLAG).catch(() => null);
    res.json({ ...(await claimsSummary()), active: Boolean(flag?.enabled) });
  } catch (err) {
    console.error("claims admin: summary", err);
    fail(res, 500, "claims_summary_failed", "Could not load the claims summary");
  }
};

/* --------------------------------------------------------------- detail */

export const getClaim = async (req, res) => {
  const detail = await getClaimDetail(Number(req.params.id));
  if (!detail) return fail(res, 404, "not_found", "Claim not found");
  await logAudit(req, "claim.view", { entity: "claim", entityId: detail.id, detail: { reference: detail.reference } });
  res.json({ claim: detail, staffTargets: STAFF_TARGETS });
};

export const postStatus = async (req, res) => {
  const to = String(req.body?.to || "");
  const note = String(req.body?.note || "").trim().slice(0, 500) || null;
  if (!STAFF_TARGETS.includes(to)) return fail(res, 400, "invalid_status", `Status must be one of: ${STAFF_TARGETS.join(", ")}`);
  const r = await transition(Number(req.params.id), to, { userId: req.user.id, note });
  if (!r.ok) {
    return r.reason === "not_found"
      ? fail(res, 404, "not_found", "Claim not found")
      : fail(res, 409, "illegal_transition", `A ${r.from} claim cannot move to ${to}`, { from: r.from });
  }
  await logAudit(req, "claim.status", { entity: "claim", entityId: req.params.id, detail: { from: r.from, to, note } });
  res.json({ ok: true, from: r.from, to });
};

/* ------------------------------------------------------------ documents */

/** A link that works for five minutes, for this user, for this file only. */
export const getDocumentLink = async (req, res) => {
  const doc = await getDocument(Number(req.params.docId));
  if (!doc || doc.claim_id !== Number(req.params.id)) return fail(res, 404, "not_found", "Document not found");
  if (doc.status !== "stored") return fail(res, 409, "not_available", `This document is ${doc.status}`);
  const { exp, sig } = signDocumentLink(doc.id, req.user.id);
  await logAudit(req, "claim_document.link", { entity: "claim_document", entityId: doc.id, detail: { claimId: doc.claim_id } });
  const base = `/api/admin/claims/documents/${doc.id}/file?u=${req.user.id}&exp=${exp}&sig=${sig}`;
  res.json({ url: base, downloadUrl: `${base}&download=1`, expiresInSeconds: LINK_TTL_SECONDS, mime: doc.detected_mime, filename: doc.original_filename });
};

/**
 * The file itself. No bearer token here (an <img> or <iframe> cannot send
 * one): the signed link IS the authorisation, and it names the user, so the
 * view is audited against them.
 */
export const getDocumentFile = async (req, res) => {
  const id = Number(req.params.docId);
  const v = verifyDocumentLink(id, req.query);
  if (!v.ok) return fail(res, v.reason === "expired" ? 410 : 403, `link_${v.reason}`, v.reason === "expired" ? "This link has expired. Open the document again from the claim." : "Invalid link");
  const doc = await getDocument(id);
  if (!doc || doc.status !== "stored" || !doc.storage_key) return fail(res, 404, "not_found", "Document not found");
  let bytes;
  try {
    bytes = readDecrypted(doc.storage_key);
  } catch (err) {
    console.error("claims admin: document read failed", id, err.message);
    return fail(res, 500, "document_unreadable", "This document could not be read");
  }
  await logAudit({ user: { id: v.userId }, ip: req.ip, headers: req.headers }, req.query.download ? "claim_document.download" : "claim_document.view", {
    entity: "claim_document", entityId: id, detail: { claimId: doc.claim_id },
  });
  const name = String(doc.original_filename || `document-${id}`).replace(/["\r\n]/g, "");
  res.setHeader("Content-Type", doc.detected_mime || "application/octet-stream");
  res.setHeader("Content-Length", bytes.length);
  res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${name}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.end(bytes);
};

/* ------------------------------------------------------------- settings */

const CLAIM_KEYS = Object.keys(SETTING_REGISTRY).filter((k) => k.startsWith("claims."));

export const getClaimSettings = async (_req, res) => {
  const resolved = await loadSettings({ force: true });
  const rows = await getSettingRows(CLAIM_KEYS);
  const meta = new Map(rows.map((r) => [r.setting_key, r]));
  res.json({
    settings: CLAIM_KEYS.map((key) => {
      const def = SETTING_REGISTRY[key];
      return {
        key,
        group: def.group,
        type: def.type,
        value: resolved[key] ?? def.default ?? null,
        default: def.default ?? null,
        allowed: def.allowed || null,
        min: def.min ?? null,
        max: def.max ?? null,
        description: def.description || null,
        updatedAt: meta.get(key)?.updated_at || null,
      };
    }),
  });
};

export const putClaimSettings = async (req, res) => {
  const incoming = req.body?.settings ?? req.body;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return fail(res, 400, "validation_error", "Expected an object of setting keys and values");
  const entries = [];
  const errors = [];
  for (const [key, raw] of Object.entries(incoming)) {
    if (!CLAIM_KEYS.includes(key)) { errors.push({ key, message: "Unknown claims setting" }); continue; }
    const r = validateSettingValue(key, raw);
    if (!r.ok) { errors.push({ key, message: r.message }); continue; }
    entries.push({ key, value: r.value });
  }
  if (errors.length) return fail(res, 400, "validation_error", "Some settings could not be saved", { fields: errors });
  const changed = await saveSettings(entries, req.user.id);
  invalidateSettings();
  await logAudit(req, "claims.settings", { entity: "settings", entityId: "claims", detail: { changed } });
  res.json({ ok: true, changed });
};

/* ----------------------------------------------------------- categories */

export const getCategories = async (_req, res) => {
  res.json({ categories: await listAllCategories({ force: true }) });
};

export const postCategory = async (req, res) => {
  const all = await listAllCategories({ force: true });
  const v = validateCategoryInput(req.body, { all });
  if (!v.ok) return fail(res, 400, "validation_error", "Invalid category", { fields: v.errors });
  const id = await createCategory(v.value, { userId: req.user.id });
  invalidateCategories();
  await logAudit(req, "claim_category.create", { entity: "claim_category", entityId: v.value.code, detail: v.value });
  res.status(201).json({ id, category: (await listAllCategories({ force: true })).find((c) => c.code === v.value.code) });
};

export const putCategory = async (req, res) => {
  const all = await listAllCategories({ force: true });
  const existing = all.find((c) => c.code === req.params.code);
  if (!existing) return fail(res, 404, "not_found", "Category not found");
  const v = validateCategoryInput(req.body, { existing, all });
  if (!v.ok) return fail(res, 400, "validation_error", "Invalid category", { fields: v.errors });
  await updateCategory(existing.code, v.value, { userId: req.user.id });
  invalidateCategories();
  await logAudit(req, "claim_category.update", { entity: "claim_category", entityId: existing.code, detail: { before: existing, after: v.value } });
  res.json({ category: (await listAllCategories({ force: true })).find((c) => c.code === existing.code) });
};

/* ------------------------------------------------------------ activation */

export const getActivation = async (_req, res) => {
  const [flag, allowlist, audit] = await Promise.all([getFlag(CLAIMS_FLAG), listAllowlist(CLAIMS_FLAG), listFlagAudit(CLAIMS_FLAG, { limit: 30 })]);
  res.json({ flag, allowlist, audit });
};

/**
 * Switch claims on or off for everyone. The panel shows what this will do and
 * asks for confirmation; the request must carry confirm: true so a stray call
 * cannot flip it.
 */
export const putActivation = async (req, res) => {
  if (typeof req.body?.enabled !== "boolean") return fail(res, 400, "validation_error", "enabled must be true or false");
  if (req.body?.confirm !== true) return fail(res, 400, "confirmation_required", "Confirm the change to apply it");
  const r = await setFlag(CLAIMS_FLAG, req.body.enabled, { userId: req.user.id, ip: req.ip });
  clearFlagCache(CLAIMS_FLAG);
  await logAudit(req, req.body.enabled ? "claims.enable" : "claims.disable", { entity: "feature_flag", entityId: CLAIMS_FLAG, detail: r });
  res.json({ ok: true, flag: await getFlag(CLAIMS_FLAG), changed: r?.changed !== false });
};

export const getAllowlist = async (_req, res) => {
  res.json({ allowlist: await listAllowlist(CLAIMS_FLAG) });
};

export const postAllowlist = async (req, res) => {
  const r = await addToAllowlist(CLAIMS_FLAG, req.body?.waNumber, { label: req.body?.label || null, userId: req.user.id, ip: req.ip });
  if (!r.ok) return fail(res, 400, r.reason, r.reason === "invalid_number" ? "Enter the full WhatsApp number with country code, 8 to 15 digits" : r.reason);
  await logAudit(req, "claims.allowlist_add", { entity: "feature_flag", entityId: CLAIMS_FLAG, detail: { label: req.body?.label || null, last4: r.waNumber.slice(-4) } });
  res.status(r.added ? 201 : 200).json({ ok: true, added: r.added });
};

export const deleteAllowlist = async (req, res) => {
  const r = await removeFromAllowlist(CLAIMS_FLAG, req.params.waNumber, { userId: req.user.id, ip: req.ip });
  if (!r?.removed) return fail(res, 404, "not_found", "That number is not on the list");
  await logAudit(req, "claims.allowlist_remove", { entity: "feature_flag", entityId: CLAIMS_FLAG, detail: { last4: String(req.params.waNumber).replace(/\D/g, "").slice(-4) } });
  res.json({ ok: true });
};
