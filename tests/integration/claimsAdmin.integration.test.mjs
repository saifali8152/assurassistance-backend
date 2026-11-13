// tests/integration/claimsAdmin.integration.test.mjs
//
// Milestone 5, Days 11–12 over real HTTP: the claims admin routes mounted on
// an Express app exactly as server.js mounts them, called with real JWTs.
// Checks who can do what (D12), that views are audited, that status changes
// follow the state machine, that document links expire and are per-user, and
// that the switch needs an explicit confirmation.
//
// OPT-IN: set IT_DB_NAME to a throwaway database that has been migrated.
//
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

process.env.JWT_SECRET = process.env.JWT_SECRET || "it-secret";
process.env.CLAIMS_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claimsadmin-"));

const express = (await import("express")).default;
const jwt = (await import("jsonwebtoken")).default;
const { initializePool, getPool } = await import("../../utils/db.js");
const claimsAdminRoutes = (await import("../../routes/claimsAdminRoutes.js")).default;
const { createDraft, submitClaim } = await import("../../models/claimModel.js");
const { ingestDocument } = await import("../../models/claimDocumentModel.js");
const { invalidateAccessCache } = await import("../../models/accessModel.js");
const { CLAIMS_FLAG, setFlag, clearFlagCache } = await import("../../utils/featureFlags.js");

const CONFIGURED = Boolean(process.env.IT_DB_NAME);
const skip = CONFIGURED ? false : "set IT_DB_NAME to run integration tests";
if (CONFIGURED) {
  initializePool({
    DB_HOST: process.env.IT_DB_HOST || "127.0.0.1",
    DB_PORT: Number(process.env.IT_DB_PORT || 3306),
    DB_USER: process.env.IT_DB_USER || "root",
    DB_PASSWORD: process.env.IT_DB_PASSWORD || "",
    DB_NAME: process.env.IT_DB_NAME,
  });
}

const RUN = Date.now().toString().slice(-7);
let seq = 0;
let server;
let base;
const PDF = Buffer.from("%PDF-1.4\nclaim\n%%EOF\n", "latin1");

if (CONFIGURED) {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/claims", claimsAdminRoutes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
}

async function user(role, { customRole = null } = {}) {
  const [r] = await getPool().execute(
    `INSERT INTO users (name, email, password, role, status) VALUES (?, ?, 'x', ?, 'active')`,
    [`IT ${role}`, `ca-${RUN}-${++seq}@example.test`, role]
  );
  if (customRole) {
    const [[role_]] = await getPool().query(`SELECT id FROM access_roles WHERE code = ?`, [customRole]);
    await getPool().execute(`UPDATE users SET access_role_id = ? WHERE id = ?`, [role_.id, r.insertId]);
  }
  invalidateAccessCache();
  return { id: r.insertId, role, token: jwt.sign({ id: r.insertId, role }, process.env.JWT_SECRET) };
}

const call = (u, method, url, body) =>
  fetch(`${base}${url}`, {
    method,
    headers: { ...(u ? { Authorization: `Bearer ${u.token}` } : {}), "Content-Type": "application/json" },
    body: body && method !== "GET" && method !== "HEAD" ? JSON.stringify(body) : undefined,
  });

async function submittedClaim({ isTest = false, priority = "normal" } = {}) {
  const [p] = await getPool().execute(
    `INSERT INTO external_policies (policy_number, holder_first_name, holder_last_name, start_date, end_date, is_test, source) VALUES (?, 'ADA', 'KOFFI', CURDATE() - INTERVAL 5 DAY, CURDATE() + INTERVAL 10 DAY, ?, 'manual')`,
    [`ADM-${RUN}-${++seq}`, isTest ? 1 : 0]
  );
  const wa = `2253${RUN}${seq}`;
  const id = await createDraft({ waNumber: wa, externalPolicyId: p.insertId, isTest });
  const doc = await ingestDocument({ claimId: id, waMessageId: `wamid.adm.${RUN}.${seq}`, buffer: PDF, filename: "rapport.pdf", claimsConfig: {} });
  const r = await submitClaim({
    claimId: id, waNumber: wa, config: {},
    state: { category: { code: "travel" }, subcategory: { code: "theft" }, incidentDate: "2026-11-01", city: "Abidjan", description: "Vol de bagage à la gare routière.", fields: {}, flags: [], priority },
  });
  return { id, reference: r.reference, wa, documentId: doc.documentId };
}

/* ------------------------------------------------------------ gating */

test("no token: 401; an agent with no claims role: 403 everywhere", { skip }, async () => {
  assert.equal((await call(null, "GET", "/api/admin/claims")).status, 401);
  const agent = await user("agent");
  for (const [m, u] of [["GET", "/api/admin/claims"], ["GET", "/api/admin/claims/settings"], ["PUT", "/api/admin/claims/activation"], ["POST", "/api/admin/claims/allowlist"]]) {
    assert.equal((await call(agent, m, u, {})).status, 403, `${m} ${u}`);
  }
});

test("a claims handler sees and updates claims, but cannot touch settings or the switch", { skip }, async () => {
  const h = await user("agent", { customRole: "claims_handler" });
  assert.equal((await call(h, "GET", "/api/admin/claims")).status, 200);
  assert.equal((await call(h, "GET", "/api/admin/claims/settings")).status, 403);
  assert.equal((await call(h, "PUT", "/api/admin/claims/activation", { enabled: true, confirm: true })).status, 403);
  assert.equal((await call(h, "POST", "/api/admin/claims/categories", {})).status, 403);
});

/* -------------------------------------------------------------- list */

test("list: urgent open claims first, numbers masked, test claims hidden unless asked", { skip }, async () => {
  const admin = await user("admin");
  const normal = await submittedClaim();
  const urgent = await submittedClaim({ priority: "urgent" });
  const testClaim = await submittedClaim({ isTest: true });
  let body = await (await call(admin, "GET", "/api/admin/claims?limit=100")).json();
  assert.equal(body.claims[0].urgentOpen, true, "urgent pinned to the top");
  assert.ok(body.claims.some((c) => c.id === normal.id));
  assert.ok(!body.claims.some((c) => c.id === testClaim.id), "test claims hidden by default");
  const row = body.claims.find((c) => c.id === urgent.id);
  assert.match(row.waNumber, /^••••\d{4}$/);
  body = await (await call(admin, "GET", "/api/admin/claims?includeTest=1&limit=100")).json();
  assert.ok(body.claims.some((c) => c.id === testClaim.id));
  body = await (await call(admin, "GET", `/api/admin/claims?q=${encodeURIComponent(normal.reference)}`)).json();
  assert.equal(body.claims.length, 1);
});

/* ------------------------------------------------- detail and status */

test("detail: everything, full number, and the view is audited", { skip }, async () => {
  const admin = await user("admin");
  const c = await submittedClaim();
  const res = await call(admin, "GET", `/api/admin/claims/${c.id}`);
  const { claim } = await res.json();
  assert.equal(claim.reference, c.reference);
  assert.equal(claim.waNumber, c.wa, "full number on the detail");
  assert.equal(claim.documents.length, 1);
  assert.equal(claim.history.at(-1).to_status, "submitted");
  const [[a]] = await getPool().query(`SELECT COUNT(*) AS n FROM admin_audit_log WHERE action = 'claim.view' AND entity_id = ? AND user_id = ?`, [String(c.id), admin.id]);
  assert.equal(Number(a.n), 1);
});

test("status: under review then closed, with notes in the history; nothing else is allowed", { skip }, async () => {
  const h = await user("agent", { customRole: "claims_handler" });
  const c = await submittedClaim();
  assert.equal((await call(h, "POST", `/api/admin/claims/${c.id}/status`, { to: "draft" })).status, 400);
  assert.equal((await call(h, "POST", `/api/admin/claims/${c.id}/status`, { to: "under_review", note: "Pris en charge" })).status, 200);
  assert.equal((await call(h, "POST", `/api/admin/claims/${c.id}/status`, { to: "closed", note: "Réglé" })).status, 200);
  assert.equal((await call(h, "POST", `/api/admin/claims/${c.id}/status`, { to: "under_review" })).status, 409, "closed is final");
  const { claim } = await (await call(h, "GET", `/api/admin/claims/${c.id}`)).json();
  assert.deepEqual(claim.history.map((x) => x.to_status), ["draft", "submitted", "under_review", "closed"]);
  assert.equal(claim.history[2].note, "Pris en charge");
  assert.equal(claim.history[2].changed_by_user_id, h.id);
});

/* --------------------------------------------------------- documents */

test("documents: a signed link opens the file for five minutes, then not; every view audited", { skip }, async () => {
  const h = await user("agent", { customRole: "claims_handler" });
  const c = await submittedClaim();
  const link = await (await call(h, "GET", `/api/admin/claims/${c.id}/documents/${c.documentId}/link`)).json();
  assert.equal(link.expiresInSeconds, 300);
  const file = await fetch(`${base}${link.url}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "application/pdf");
  assert.equal(file.headers.get("cache-control"), "private, no-store");
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(PDF));

  const forged = link.url.replace(/sig=[0-9a-f]+/, `sig=${"0".repeat(64)}`);
  assert.equal((await fetch(`${base}${forged}`)).status, 403);
  const otherUser = link.url.replace(/u=\d+/, "u=1");
  assert.equal((await fetch(`${base}${otherUser}`)).status, 403, "a link is bound to the user it was made for");
  const expired = link.url.replace(/exp=\d+/, `exp=${Math.floor(Date.now() / 1000) - 10}`);
  assert.ok([403, 410].includes((await fetch(`${base}${expired}`)).status));

  const [[a]] = await getPool().query(`SELECT COUNT(*) AS n FROM admin_audit_log WHERE action = 'claim_document.view' AND entity_id = ? AND user_id = ?`, [String(c.documentId), h.id]);
  assert.equal(Number(a.n), 1);
});

test("documents: the link must belong to the claim in the URL", { skip }, async () => {
  const admin = await user("admin");
  const a = await submittedClaim();
  const b = await submittedClaim();
  assert.equal((await call(admin, "GET", `/api/admin/claims/${a.id}/documents/${b.documentId}/link`)).status, 404);
});

/* ------------------------------------------------------- the switch */

test("activation: needs confirm:true, is audited, and the flag really changes", { skip }, async () => {
  const admin = await user("admin");
  await setFlag(CLAIMS_FLAG, false);
  assert.equal((await call(admin, "PUT", "/api/admin/claims/activation", { enabled: true })).status, 400);
  assert.equal((await call(admin, "PUT", "/api/admin/claims/activation", { enabled: true, confirm: true })).status, 200);
  let body = await (await call(admin, "GET", "/api/admin/claims/activation")).json();
  assert.equal(body.flag.enabled, true);
  assert.equal(body.flag.updatedBy.id, admin.id);
  await call(admin, "PUT", "/api/admin/claims/activation", { enabled: false, confirm: true });
  clearFlagCache();
  body = await (await call(admin, "GET", "/api/admin/claims/summary")).json();
  assert.equal(body.active, false);
  const [[a]] = await getPool().query(`SELECT COUNT(*) AS n FROM admin_audit_log WHERE action IN ('claims.enable','claims.disable') AND user_id = ?`, [admin.id]);
  assert.equal(Number(a.n), 2);
});

test("allowlist: add, refuse a malformed number, remove", { skip }, async () => {
  const admin = await user("admin");
  const num = `+225 07 ${RUN}`;
  assert.equal((await call(admin, "POST", "/api/admin/claims/allowlist", { waNumber: num, label: "QA phone" })).status, 201);
  assert.equal((await call(admin, "POST", "/api/admin/claims/allowlist", { waNumber: "123" })).status, 400);
  const list = await (await call(admin, "GET", "/api/admin/claims/allowlist")).json();
  assert.ok(list.allowlist.some((x) => (x.label || "") === "QA phone"));
  assert.equal((await call(admin, "DELETE", `/api/admin/claims/allowlist/${num.replace(/\D/g, "")}`)).status, 200);
  assert.equal((await call(admin, "DELETE", `/api/admin/claims/allowlist/${num.replace(/\D/g, "")}`)).status, 404);
});

/* ------------------------------------------------ settings, categories */

test("settings: claims keys only, validated, saved", { skip }, async () => {
  const admin = await user("admin");
  const s = await (await call(admin, "GET", "/api/admin/claims/settings")).json();
  assert.equal(s.settings.length, 23);
  assert.ok(s.settings.every((x) => x.key.startsWith("claims.")));
  assert.equal((await call(admin, "PUT", "/api/admin/claims/settings", { "whatsapp.access_token": "x" })).status, 400, "cannot reach other settings through here");
  assert.equal((await call(admin, "PUT", "/api/admin/claims/settings", { "claims.expiry_rule": "yesterday" })).status, 400);
  assert.equal((await call(admin, "PUT", "/api/admin/claims/settings", { "claims.max_documents": 6 })).status, 200);
  await call(admin, "PUT", "/api/admin/claims/settings", { "claims.max_documents": 10 });
});

test("categories: add one, refuse a too-long name, deactivate instead of delete", { skip }, async () => {
  const admin = await user("admin");
  const code = `it_cat_${RUN}`;
  assert.equal((await call(admin, "POST", "/api/admin/claims/categories", { code, parent_code: "legal", name_fr: "x".repeat(25), name_en: "x" })).status, 400);
  assert.equal((await call(admin, "POST", "/api/admin/claims/categories", { code, parent_code: "travel", name_fr: "Test IT", name_en: "IT test" })).status, 201);
  const r = await call(admin, "PUT", `/api/admin/claims/categories/${code}`, { active: false });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).category.active, false);
});

test.after(async () => {
  fs.rmSync(process.env.CLAIMS_STORAGE_DIR, { recursive: true, force: true });
  if (!CONFIGURED) return;
  server.close();
  await getPool().end();
});
