// src/models/claimCategoryModel.js
//
// Claim categories as the conversation and the admin panel read them.
//
// Read on every step of a claim conversation, so cached for 30 seconds — the
// same window as settings — and invalidated by every write. JSON columns are
// parsed defensively: a malformed value edited in by hand degrades to "nothing
// required" rather than crashing a customer's claim.
//
import getPool from "../utils/db.js";
import { NAME_MAX, HINT_MAX, PRIORITIES, FIELD_TYPES, MAX_SUBCATEGORIES_PER_CATEGORY } from "../utils/claims/defaultCategories.js";

const TTL_MS = 30_000;
let cache = null;
let cachedAt = 0;

function parseJson(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "object") return raw;
  try {
    const v = JSON.parse(raw);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function mapCategory(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    parentCode: row.parent_code || null,
    nameFr: row.name_fr,
    nameEn: row.name_en,
    hintFr: row.hint_fr || "",
    hintEn: row.hint_en || "",
    requiredDocuments: parseJson(row.required_documents, []),
    optionalDocuments: parseJson(row.optional_documents, []),
    extraFields: parseJson(row.extra_fields, []),
    defaultPriority: PRIORITIES.includes(row.default_priority) ? row.default_priority : "normal",
    guaranteeCodes: parseJson(row.guarantee_codes, null),
    active: Boolean(Number(row.active)),
    sortOrder: Number(row.sort_order) || 0,
    updatedAt: row.updated_at || null,
  };
}

export function invalidateCategories() {
  cache = null;
  cachedAt = 0;
}

/** Every category, active or not, in display order. */
export async function listAllCategories({ force = false } = {}) {
  if (!force && cache && Date.now() - cachedAt < TTL_MS) return cache;
  const [rows] = await getPool().query(
    `SELECT * FROM claim_categories ORDER BY (parent_code IS NOT NULL), sort_order, id`
  );
  cache = rows.map(mapCategory);
  cachedAt = Date.now();
  return cache;
}

/** What the conversation offers: active parents, each with its active children. */
export async function getCategoryTree() {
  const all = await listAllCategories();
  const parents = all.filter((c) => !c.parentCode && c.active);
  return parents
    .map((p) => ({
      ...p,
      children: all
        .filter((c) => c.parentCode === p.code && c.active)
        .slice(0, MAX_SUBCATEGORIES_PER_CATEGORY),
    }))
    .filter((p) => p.children.length > 0);
}

export async function getCategory(code) {
  const all = await listAllCategories();
  return all.find((c) => c.code === code) || null;
}

/* ---------------------------------------------------------------- editing */

const CODE = /^[a-z][a-z0-9_]{1,59}$/;

function validateDocs(list, label) {
  if (!Array.isArray(list)) return `${label} must be a list`;
  if (list.length > 15) return `${label}: at most 15`;
  const codes = new Set();
  for (const d of list) {
    if (!d || !CODE.test(String(d.code || ""))) return `${label}: each needs a code (lowercase letters, digits, _)`;
    if (codes.has(d.code)) return `${label}: duplicate code ${d.code}`;
    codes.add(d.code);
    if (!String(d.label_fr || "").trim() || !String(d.label_en || "").trim()) return `${label}: ${d.code} needs a French and an English label`;
    if (String(d.label_fr).length > 120 || String(d.label_en).length > 120) return `${label}: ${d.code} label is too long`;
  }
  return null;
}

function validateFields(list) {
  if (!Array.isArray(list)) return "extra fields must be a list";
  if (list.length > 8) return "at most 8 extra fields";
  const keys = new Set();
  for (const f of list) {
    if (!f || !CODE.test(String(f.key || ""))) return "each extra field needs a key (lowercase letters, digits, _)";
    if (keys.has(f.key)) return `duplicate field ${f.key}`;
    keys.add(f.key);
    if (!FIELD_TYPES.includes(f.type)) return `${f.key}: type must be one of ${FIELD_TYPES.join(", ")}`;
    for (const k of ["label_fr", "label_en", "prompt_fr", "prompt_en"]) {
      if (!String(f[k] || "").trim()) return `${f.key}: ${k} is required`;
    }
    if (String(f.prompt_fr).length > 500 || String(f.prompt_en).length > 500) return `${f.key}: prompt is too long`;
    if (f.type === "choice") {
      if (!Array.isArray(f.options) || f.options.length < 2 || f.options.length > 10) return `${f.key}: a choice needs 2 to 10 options`;
      for (const o of f.options) {
        if (!String(o?.value || "").trim() || !String(o?.label_fr || "").trim() || !String(o?.label_en || "").trim()) {
          return `${f.key}: every option needs a value and French and English labels`;
        }
        if (String(o.label_fr).length > 20 || String(o.label_en).length > 20) return `${f.key}: option labels are 20 characters at most`;
      }
    }
    if (f.type === "number" && f.min !== undefined && f.max !== undefined && Number(f.min) > Number(f.max)) {
      return `${f.key}: min is greater than max`;
    }
  }
  return null;
}

/** Validate a category body for create/update. Returns { ok, value } or { ok:false, errors }. */
export function validateCategoryInput(body, { existing = null, all = [] } = {}) {
  const errors = {};
  const v = {};
  const code = existing ? existing.code : String(body.code || "").trim();
  if (!existing && !CODE.test(code)) errors.code = "lowercase letters, digits and _, starting with a letter";
  if (!existing && all.some((c) => c.code === code)) errors.code = "this code already exists";
  v.code = code;

  const parent = existing ? existing.parentCode : (body.parent_code ? String(body.parent_code).trim() : null);
  if (!existing && parent) {
    const p = all.find((c) => c.code === parent);
    if (!p || p.parentCode) errors.parent_code = "must be one of the top-level categories";
    else if (all.filter((c) => c.parentCode === parent && c.active).length >= MAX_SUBCATEGORIES_PER_CATEGORY) {
      errors.parent_code = `a category can hold ${MAX_SUBCATEGORIES_PER_CATEGORY} active sub-categories (a WhatsApp list limit)`;
    }
  }
  v.parent_code = parent;

  for (const [k, max] of [["name_fr", NAME_MAX], ["name_en", NAME_MAX]]) {
    const s = String(body[k] ?? existing?.[k === "name_fr" ? "nameFr" : "nameEn"] ?? "").trim();
    if (!s) errors[k] = "required";
    else if (s.length > max) errors[k] = `${max} characters at most — WhatsApp cuts list titles there`;
    v[k] = s;
  }
  for (const [k, ek] of [["hint_fr", "hintFr"], ["hint_en", "hintEn"]]) {
    const s = String(body[k] ?? existing?.[ek] ?? "").trim();
    if (s.length > HINT_MAX) errors[k] = `${HINT_MAX} characters at most`;
    v[k] = s || null;
  }

  const req = body.required_documents ?? existing?.requiredDocuments ?? [];
  const opt = body.optional_documents ?? existing?.optionalDocuments ?? [];
  const fields = body.extra_fields ?? existing?.extraFields ?? [];
  const e1 = validateDocs(req, "required documents");
  const e2 = validateDocs(opt, "optional documents");
  const e3 = validateFields(fields);
  if (e1) errors.required_documents = e1;
  if (e2) errors.optional_documents = e2;
  if (e3) errors.extra_fields = e3;
  const overlap = (req || []).filter((d) => (opt || []).some((o) => o.code === d.code)).map((d) => d.code);
  if (!e1 && !e2 && overlap.length) errors.optional_documents = `listed as both required and optional: ${overlap.join(", ")}`;
  v.required_documents = req;
  v.optional_documents = opt;
  v.extra_fields = fields;

  const pr = body.default_priority ?? existing?.defaultPriority ?? "normal";
  if (!PRIORITIES.includes(pr)) errors.default_priority = `one of ${PRIORITIES.join(", ")}`;
  v.default_priority = pr;

  const g = body.guarantee_codes !== undefined ? body.guarantee_codes : existing?.guaranteeCodes ?? null;
  if (g !== null && (!Array.isArray(g) || g.some((x) => !/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(String(x))))) {
    errors.guarantee_codes = "a list of guarantee codes, or empty";
  }
  v.guarantee_codes = Array.isArray(g) && g.length ? g : null;

  v.active = body.active !== undefined ? Boolean(body.active) : existing ? existing.active : true;
  v.sort_order = body.sort_order !== undefined ? Number(body.sort_order) || 0 : existing?.sortOrder ?? 0;

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: v };
}

export async function createCategory(value, { userId = null } = {}) {
  const [res] = await getPool().execute(
    `INSERT INTO claim_categories
       (code, parent_code, name_fr, name_en, hint_fr, hint_en, required_documents, optional_documents,
        extra_fields, default_priority, guarantee_codes, active, sort_order, updated_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      value.code, value.parent_code, value.name_fr, value.name_en, value.hint_fr, value.hint_en,
      JSON.stringify(value.required_documents), JSON.stringify(value.optional_documents),
      JSON.stringify(value.extra_fields), value.default_priority,
      value.guarantee_codes ? JSON.stringify(value.guarantee_codes) : null,
      value.active ? 1 : 0, value.sort_order, userId,
    ]
  );
  invalidateCategories();
  return res.insertId;
}

/** Update everything except code and parent — those identify the row and its place. */
export async function updateCategory(code, value, { userId = null } = {}) {
  const [res] = await getPool().execute(
    `UPDATE claim_categories
        SET name_fr = ?, name_en = ?, hint_fr = ?, hint_en = ?,
            required_documents = ?, optional_documents = ?, extra_fields = ?,
            default_priority = ?, guarantee_codes = ?, active = ?, sort_order = ?, updated_by_user_id = ?
      WHERE code = ?`,
    [
      value.name_fr, value.name_en, value.hint_fr, value.hint_en,
      JSON.stringify(value.required_documents), JSON.stringify(value.optional_documents),
      JSON.stringify(value.extra_fields), value.default_priority,
      value.guarantee_codes ? JSON.stringify(value.guarantee_codes) : null,
      value.active ? 1 : 0, value.sort_order, userId, code,
    ]
  );
  invalidateCategories();
  return res.affectedRows > 0;
}

export const __testables = { validateDocs, validateFields };
