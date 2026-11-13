// controllers/externalPolicyController.js
//
// Milestone 5, Day 10 — imported policies (D13): list, add one, import a file
// (preview first, then commit), template, cancel/reactivate.
//
import {
  IMPORT_COLUMNS, templateCsv, parseCsv, previewImport, commitImport, listExternalPolicies, setExternalPolicyStatus,
} from "../models/externalPolicyModel.js";
import { logAudit } from "../utils/adminAudit.js";

const fail = (res, status, code, message, extra = {}) => res.status(status).json({ ok: false, code, message, ...extra });

/** The body carries either parsed rows (from an Excel file read in the browser) or raw CSV text. */
function rowsFrom(body) {
  if (Array.isArray(body?.rows)) return body.rows;
  if (typeof body?.csv === "string") return parseCsv(body.csv);
  return null;
}

const REASONS = {
  too_many_rows: (r) => `At most ${r.max} rows per file`,
  no_rows: () => "The file has no rows",
  encryption_unavailable: () => "SETTINGS_ENCRYPTION_KEY is not set on the server, so passport numbers cannot be stored securely",
  duplicate_during_import: () => "Another import added some of these policies at the same time; preview again",
};

export const getColumns = (_req, res) => res.json({ columns: IMPORT_COLUMNS });

export const getTemplate = (_req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="imported-policies-template.csv"');
  res.send(`﻿${templateCsv()}`);
};

export const getList = async (req, res) => {
  res.json(await listExternalPolicies({ q: req.query.q, status: req.query.status, isTest: req.query.isTest, page: req.query.page, limit: req.query.limit }));
};

export const postPreview = async (req, res) => {
  const rows = rowsFrom(req.body);
  if (!rows) return fail(res, 400, "validation_error", "Send rows or csv");
  const p = await previewImport(rows);
  if (!p.ok) return fail(res, 400, p.reason, REASONS[p.reason]?.(p) || p.reason);
  const { _rows, ...out } = p;
  res.json(out);
};

export const postCommit = async (req, res) => {
  const rows = rowsFrom(req.body);
  if (!rows) return fail(res, 400, "validation_error", "Send rows or csv");
  const r = await commitImport(rows, { isTest: req.body?.isTest === true, userId: req.user.id });
  if (!r.ok) return fail(res, r.reason === "encryption_unavailable" ? 503 : 400, r.reason, REASONS[r.reason]?.(r) || r.reason);
  await logAudit(req, "policies.import", { entity: "external_policy_batch", entityId: r.batchId, detail: { inserted: r.inserted, invalid: r.invalid, isTest: req.body?.isTest === true } });
  res.status(201).json(r);
};

export const postOne = async (req, res) => {
  const r = await commitImport([req.body || {}], { isTest: req.body?.is_test === true || req.body?.isTest === true, userId: req.user.id, source: "manual" });
  if (!r.ok) return fail(res, r.reason === "encryption_unavailable" ? 503 : 400, r.reason, REASONS[r.reason]?.(r) || r.reason);
  if (!r.inserted) return fail(res, 400, "validation_error", "The policy was not added", { fields: r.errors[0]?.errors || {} });
  await logAudit(req, "policies.add", { entity: "external_policy", entityId: req.body?.policy_number, detail: { isTest: Boolean(req.body?.is_test || req.body?.isTest) } });
  res.status(201).json({ ok: true });
};

export const putStatus = async (req, res) => {
  const r = await setExternalPolicyStatus(Number(req.params.id), req.body?.status);
  if (!r.ok) return fail(res, r.reason === "not_found" ? 404 : 400, r.reason, r.reason === "not_found" ? "Not found" : "status must be active or cancelled");
  await logAudit(req, "policies.status", { entity: "external_policy", entityId: req.params.id, detail: { status: req.body?.status } });
  res.json({ ok: true });
};
