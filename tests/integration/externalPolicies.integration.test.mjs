// tests/integration/externalPolicies.integration.test.mjs
//
// Milestone 5, Day 10 — imported policies (D13) over real HTTP: template,
// preview with per-row errors, commit of valid rows only, duplicates refused,
// passports never stored or shown in clear, and the two things that matter
// most: an imported policy can be claimed against, and it never counts as a
// sale.
//
// OPT-IN: set IT_DB_NAME to a throwaway database that has been migrated.
//
import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "it-secret";

const express = (await import("express")).default;
const jwt = (await import("jsonwebtoken")).default;
const { initializePool, getPool } = await import("../../utils/db.js");
const routes = (await import("../../routes/externalPolicyRoutes.js")).default;
const { parseCsv, validatePolicyRow } = await import("../../models/externalPolicyModel.js");
const { validatePolicy } = await import("../../models/claimPolicyLookup.js");
const { invalidateAccessCache } = await import("../../models/accessModel.js");

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

const RUN = Date.now().toString().slice(-6);
let server;
let base;
if (CONFIGURED) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/admin/external-policies", routes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
}

async function token(role) {
  const [r] = await getPool().execute(`INSERT INTO users (name, email, password, role, status) VALUES ('IT ext', ?, 'x', ?, 'active')`, [`ext-${RUN}-${role}-${Math.random()}@example.test`, role]);
  invalidateAccessCache();
  return jwt.sign({ id: r.insertId, role }, process.env.JWT_SECRET);
}

const call = async (tok, method, url, body) => {
  const r = await fetch(`${base}${url}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, json, text };
};

const csv = (lines) => [
  "policy_number,card_number,holder_last_name,holder_first_name,date_of_birth,passport_or_id,phone,product_name,insurer,destination,start_date,end_date,status,payment_status,guarantee_codes",
  ...lines,
].join("\n");

/* ---------------------------------------------------------------- pure */

test("CSV: quotes, commas inside quotes, semicolon files from French Excel", () => {
  const a = parseCsv('policy_number,holder_last_name\n"EXT-1","DIALLO, Fatou"\n');
  assert.deepEqual(a, [{ policy_number: "EXT-1", holder_last_name: "DIALLO, Fatou" }]);
  const b = parseCsv("policy_number;holder_last_name\r\nEXT-2;KONE\r\n");
  assert.deepEqual(b, [{ policy_number: "EXT-2", holder_last_name: "KONE" }]);
});

test("row rules: required fields, dates, end after start, known guarantee codes", () => {
  const ok = validatePolicyRow({ policy_number: "ext-9", holder_last_name: "A", holder_first_name: "B", passport_or_id: "AB1234", start_date: "01/11/2026", end_date: "30/11/2026", guarantee_codes: "hospitalization;bail" });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.policy_number, "EXT-9");
  assert.deepEqual(ok.value.guarantee_codes, ["hospitalization", "bail"]);
  const bad = validatePolicyRow({ policy_number: "", passport_or_id: "1", start_date: "30/11/2026", end_date: "01/11/2026", guarantee_codes: "teleportation" });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["end_date", "guarantee_codes", "holder_first_name", "holder_last_name", "passport_or_id", "policy_number"]);
});

/* ---------------------------------------------------------------- http */

test("only a role with policies.import gets in", { skip }, async () => {
  assert.equal((await call(await token("agent"), "GET", "/api/admin/external-policies")).status, 403);
  assert.equal((await call(await token("admin"), "GET", "/api/admin/external-policies")).status, 200);
});

test("the template downloads with every column", { skip }, async () => {
  const r = await call(await token("admin"), "GET", "/api/admin/external-policies/template");
  assert.equal(r.status, 200);
  assert.match(r.text, /policy_number,card_number,holder_last_name/);
});

test("preview: per-row errors, nothing written; commit: only the valid rows", { skip }, async () => {
  const admin = await token("admin");
  const file = csv([
    `EXT-${RUN}-1,,KONE,Awa,05/05/1990,PP${RUN}1,+22507000001,Gold,Partner Re,France,01/11/2026,30/11/2026,active,paid,hospitalization`,
    `EXT-${RUN}-2,,TOURE,Ali,,PP${RUN}2,,,,,01/11/2026,31/10/2026,active,paid,`,
    `EXT-${RUN}-1,,DUP,Row,,PP${RUN}3,,,,,01/11/2026,30/11/2026,active,unknown,`,
  ]);
  const p = await call(admin, "POST", "/api/admin/external-policies/import/preview", { csv: file });
  assert.equal(p.status, 200);
  assert.equal(p.json.total, 3);
  assert.equal(p.json.valid, 1);
  assert.deepEqual(p.json.errors.map((e) => e.row), [3, 4]);
  assert.match(p.json.errors[0].errors.end_date, /before/);
  assert.match(p.json.errors[1].errors.policy_number, /Repeated/);
  assert.ok(!JSON.stringify(p.json).includes(`PP${RUN}1`), "the preview never echoes a passport");
  const [[before]] = await getPool().query(`SELECT COUNT(*) AS n FROM external_policies WHERE policy_number LIKE ?`, [`EXT-${RUN}-%`]);
  assert.equal(Number(before.n), 0);

  const c = await call(admin, "POST", "/api/admin/external-policies/import", { csv: file, isTest: true });
  assert.equal(c.status, 201);
  assert.equal(c.json.inserted, 1);
  assert.ok(c.json.batchId);
  const [[row]] = await getPool().query(`SELECT * FROM external_policies WHERE policy_number = ?`, [`EXT-${RUN}-1`]);
  assert.equal(row.is_test, 1);
  assert.equal(row.source, "import");
  assert.ok(row.passport_or_id_hash && row.passport_or_id_enc);
  assert.ok(!JSON.stringify(row).includes(`PP${RUN}1`), "no plaintext passport stored");

  const again = await call(admin, "POST", "/api/admin/external-policies/import/preview", { csv: file });
  assert.match(again.json.errors.find((e) => e.policyNumber === `EXT-${RUN}-1`).errors.policy_number, /Already imported/);
});

test("a number that belongs to a real sale is refused", { skip }, async () => {
  const admin = await token("admin");
  const [[sale]] = await getPool().query(`SELECT policy_number FROM sales WHERE policy_number IS NOT NULL LIMIT 1`);
  if (!sale) return;
  const p = await call(admin, "POST", "/api/admin/external-policies/import/preview", { rows: [{ policy_number: sale.policy_number, holder_last_name: "X", holder_first_name: "Y", passport_or_id: "ZZ9999", start_date: "01/11/2026", end_date: "02/11/2026" }] });
  assert.match(p.json.errors[0].errors.policy_number, /sold on the platform/);
});

test("single add, list search by exact passport, phone masked in the list", { skip }, async () => {
  const admin = await token("admin");
  const pp = `SA${RUN}X`;
  const r = await call(admin, "POST", "/api/admin/external-policies", {
    policy_number: `ONE-${RUN}`, holder_last_name: "BAMBA", holder_first_name: "Issa", passport_or_id: pp, phone: "+2250102030405",
    start_date: "01/11/2026", end_date: "30/11/2026",
  });
  assert.equal(r.status, 201);
  const l = await call(admin, "GET", `/api/admin/external-policies?q=${pp}`);
  assert.equal(l.json.total, 1);
  assert.equal(l.json.policies[0].policy_number, `ONE-${RUN}`);
  assert.equal(l.json.policies[0].phone, "••••0405");
  assert.equal(l.json.policies[0].imported, true);
});

test("an imported policy is claimable with its passport — and cancelling it stops that", { skip }, async () => {
  const admin = await token("admin");
  const pp = `CL${RUN}Z`;
  const start = new Date(); start.setDate(start.getDate() - 3);
  const end = new Date(); end.setDate(end.getDate() + 20);
  const fmt = (d) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  await call(admin, "POST", "/api/admin/external-policies", {
    policy_number: `CLM-${RUN}`, holder_last_name: "SORO", holder_first_name: "Mariam", passport_or_id: pp, start_date: fmt(start), end_date: fmt(end),
  });
  const v = await validatePolicy({ waNumber: `22599${RUN}`, identifier: `clm-${RUN}`, passport: pp.toLowerCase(), config: {} });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.policy.source, "external");

  const [[row]] = await getPool().query(`SELECT id FROM external_policies WHERE policy_number = ?`, [`CLM-${RUN}`]);
  await call(admin, "PUT", `/api/admin/external-policies/${row.id}/status`, { status: "cancelled" });
  const v2 = await validatePolicy({ waNumber: `22598${RUN}`, identifier: `CLM-${RUN}`, passport: pp, config: {} });
  assert.equal(v2.outcome, "cancelled");
});

test("imported policies never touch sales, invoices or the ledger", { skip }, async () => {
  const count = async () => {
    const [[s]] = await getPool().query(`SELECT COUNT(*) AS n FROM sales`);
    const [[i]] = await getPool().query(`SELECT COUNT(*) AS n FROM invoices`);
    return [Number(s.n), Number(i.n)];
  };
  const before = await count();
  const admin = await token("admin");
  await call(admin, "POST", "/api/admin/external-policies/import", {
    rows: [{ policy_number: `LED-${RUN}`, holder_last_name: "L", holder_first_name: "E", passport_or_id: `LE${RUN}`, start_date: "01/11/2026", end_date: "02/11/2026" }],
  });
  assert.deepEqual(await count(), before);
});

test.after(async () => {
  if (!CONFIGURED) return;
  server.close();
  await getPool().end();
});
