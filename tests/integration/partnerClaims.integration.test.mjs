// tests/integration/partnerClaims.integration.test.mjs
//
// D10 — claim status on the 3rd-party API, over real HTTP with real API keys.
// A key needs claims:read; it sees only claims on policies its owner can see;
// it never sees test claims, drafts, descriptions, documents, passports or
// phone numbers.
//
// OPT-IN: set IT_DB_NAME to a throwaway database that has been migrated.
//
import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "it-secret";
const express = (await import("express")).default;
const { initializePool, getPool } = await import("../../utils/db.js");
const routes = (await import("../../routes/partnerClaimsRoutes.js")).default;
const { generateApiKeySecret, insertApiKey } = await import("../../models/apiKeyModel.js");
const { issuePolicy } = await import("../../models/policyIssuance.js");
const { createDraft, submitClaim } = await import("../../models/claimModel.js");

const CONFIGURED = Boolean(process.env.IT_DB_NAME);
const skip = CONFIGURED ? false : "set IT_DB_NAME to run integration tests";
let server, base;
const RUN = Date.now().toString().slice(-6);
let seq = 0;

if (CONFIGURED) {
  initializePool({
    DB_HOST: process.env.IT_DB_HOST || "127.0.0.1", DB_PORT: Number(process.env.IT_DB_PORT || 3306),
    DB_USER: process.env.IT_DB_USER || "root", DB_PASSWORD: process.env.IT_DB_PASSWORD || "", DB_NAME: process.env.IT_DB_NAME,
  });
  const app = express();
  app.use(express.json());
  app.use("/api/claims", routes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
}

async function user(role) {
  const [r] = await getPool().execute(`INSERT INTO users (name, email, password, role, status) VALUES ('IT partner', ?, 'x', ?, 'active')`, [`pc-${RUN}-${++seq}@example.test`, role]);
  return r.insertId;
}
async function key(ownerUserId, scopes) {
  const s = generateApiKeySecret();
  await insertApiKey({ ownerUserId, name: `it-${seq}`, keyPrefix: s.keyPrefix, keyHash: s.keyHash, scopes, createdByUserId: ownerUserId });
  return s.fullKey;
}
const get = async (k, url) => {
  const r = await fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${k}` } });
  return { status: r.status, body: await r.json() };
};

/** A policy sold by `agentId`, and a submitted claim on it. */
async function claimSoldBy(agentId, { isTest = false } = {}) {
  const pool = getPool();
  const [p] = await pool.execute(`INSERT INTO catalogue (product_type, name, coverage) VALUES ('Travel', ?, 'Medical')`, [`PC plan ${RUN}-${++seq}`]);
  const [t] = await pool.execute(`INSERT INTO travellers (first_name, last_name, passport_or_id) VALUES ('PC', 'HOLDER', ?)`, [`PCP${RUN}${seq}`]);
  const [c] = await pool.execute(
    `INSERT INTO cases (traveller_id, destination, start_date, end_date, selected_plan_id, created_by, status) VALUES (?, 'France', CURDATE(), CURDATE() + INTERVAL 10 DAY, ?, ?, 'Confirmed')`,
    [t.insertId, p.insertId, agentId]
  );
  const sale = await issuePolicy({
    caseId: c.insertId,
    caseRow: { id: c.insertId, first_name: "PC", last_name: "HOLDER", passport_or_id: `PCP${RUN}${seq}`, destination: "France", start_date: "2026-11-01", end_date: "2026-11-30", plan_id: p.insertId, plan_name: "PC", product_type: "Travel", currency: "XOF" },
    pricing: { premium: 1000, tax: 0, total: 1000, currency: "XOF", validityDays: 10 },
  });
  const wa = `2257${RUN}${seq}`;
  const id = await createDraft({ waNumber: wa, saleId: sale.saleId, policyNumber: sale.policyNumber, isTest });
  const r = await submitClaim({ claimId: id, waNumber: wa, config: {}, state: { category: { code: "medical" }, subcategory: { code: "hospitalization" }, description: "Hospitalisation d'urgence pendant le séjour.", fields: {}, flags: [], priority: "urgent" } });
  return { reference: r.reference, policyNumber: sale.policyNumber, wa };
}

test("a key without claims:read is refused", { skip }, async () => {
  const owner = await user("admin");
  const k = await key(owner, ["cases:read"]);
  const r = await get(k, "/api/claims");
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "insufficient_scope");
});

test("an agent's key sees its own policies' claims — status only — and nobody else's", { skip }, async () => {
  const agentA = await user("agent");
  const agentB = await user("agent");
  const mine = await claimSoldBy(agentA);
  const theirs = await claimSoldBy(agentB);
  const k = await key(agentA, ["claims:read"]);

  const one = await get(k, `/api/claims/${mine.reference.toLowerCase()}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.data.status, "submitted");
  assert.equal(one.body.data.policyNumber, mine.policyNumber);
  assert.equal(one.body.data.policySource, "platform");
  const dump = JSON.stringify(one.body);
  for (const forbidden of ["description", "Hospitalisation d'urgence", mine.wa, "passport", "documents", "flags"]) {
    assert.ok(!dump.includes(forbidden), `response leaks ${forbidden}`);
  }

  assert.equal((await get(k, `/api/claims/${theirs.reference}`)).status, 404, "another agent's claim does not exist for this key");
  const list = await get(k, "/api/claims");
  assert.ok(list.body.data.some((c) => c.reference === mine.reference));
  assert.ok(!list.body.data.some((c) => c.reference === theirs.reference));
  const byPolicy = await get(k, `/api/claims?policyNumber=${mine.policyNumber}`);
  assert.equal(byPolicy.body.data.length, 1);
});

test("test claims are never returned, even to an admin key", { skip }, async () => {
  const admin = await user("admin");
  const t = await claimSoldBy(admin, { isTest: true });
  const k = await key(admin, ["claims:read"]);
  assert.equal((await get(k, `/api/claims/${t.reference}`)).status, 404);
});

test("bad filters are refused with 400, not silently ignored", { skip }, async () => {
  const admin = await user("admin");
  const k = await key(admin, ["claims:read"]);
  const a = await get(k, "/api/claims?updatedSince=banana");
  assert.equal(a.status, 400);
  assert.equal(a.body.error.code, "invalid_parameter");
  const b = await get(k, "/api/claims?status=draft");
  assert.equal(b.status, 400, "drafts are never exposed, so asking for them is an error");
  const c = await get(k, "/api/claims?updatedSince=2026-01-01T00:00:00Z&status=closed");
  assert.equal(c.status, 200);
});

test.after(async () => {
  if (!CONFIGURED) return;
  server.close();
  await getPool().end();
});
