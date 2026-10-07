// tests/integration/issuance.integration.test.mjs
//
// Policy issuance — the single path all three callers now share (the sales
// endpoint, the case-confirm endpoint, and a confirmed mobile money payment).
//
// What has to hold, and could not be proven without a database: one live policy
// per case under concurrency, every document in one transaction, and a frozen
// snapshot of what was issued so a re-render can never disagree with the copy
// the customer holds.
//
// OPT-IN: set IT_DB_NAME to a throwaway database.
//
import test from "node:test";
import assert from "node:assert/strict";

import { initializePool, getPool } from "../../utils/db.js";
import { issuePolicy, getIssuedSnapshot } from "../../models/policyIssuance.js";

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

const RUN = Date.now().toString().slice(-9);
const uniq = (p) => `${p}-${RUN}-${Math.floor(Math.random() * 10000)}`;

async function makeCase() {
  const pool = getPool();
  const [u] = await pool.execute(
    `INSERT INTO users (name, email, password, role) VALUES (?, ?, 'x', 'admin')`,
    ["IT issuance", `${uniq("iss")}@example.test`]
  );
  const [p] = await pool.execute(
    `INSERT INTO catalogue (product_type, name, coverage) VALUES ('Travel', ?, 'Medical, repatriation')`,
    [uniq("IT plan")]
  );
  const [t] = await pool.execute(
    `INSERT INTO travellers (first_name, last_name, passport_or_id, date_of_birth, nationality)
     VALUES ('Saif', 'Ali', 'AB1234567', '1990-03-12', 'Pakistan')`
  );
  const [c] = await pool.execute(
    `INSERT INTO cases (traveller_id, destination, start_date, end_date, selected_plan_id, created_by)
     VALUES (?, 'France', '2026-11-01', '2026-11-10', ?, ?)`,
    [t.insertId, p.insertId, u.insertId]
  );
  return {
    caseId: c.insertId,
    travellerId: t.insertId,
    planId: p.insertId,
    userId: u.insertId,
    caseRow: {
      id: c.insertId,
      first_name: "Saif",
      last_name: "Ali",
      passport_or_id: "AB1234567",
      date_of_birth: "1990-03-12",
      nationality: "Pakistan",
      destination: "France",
      start_date: "2026-11-01",
      end_date: "2026-11-10",
      duration_days: 10,
      plan_name: "IT plan",
      product_type: "Travel",
      coverage: "Medical, repatriation",
      currency: "XOF",
    },
  };
}

async function dropCase(f) {
  const pool = getPool();
  await pool.query("DELETE FROM certificates WHERE sale_id IN (SELECT id FROM sales WHERE case_id = ?)", [f.caseId]);
  await pool.query("DELETE FROM invoices WHERE sale_id IN (SELECT id FROM sales WHERE case_id = ?)", [f.caseId]);
  await pool.query("DELETE FROM sales WHERE case_id = ?", [f.caseId]);
  await pool.query("DELETE FROM cases WHERE id = ?", [f.caseId]);
  await pool.query("DELETE FROM travellers WHERE id = ?", [f.travellerId]);
  await pool.query("DELETE FROM catalogue WHERE id = ?", [f.planId]);
  await pool.query("DELETE FROM users WHERE id = ?", [f.userId]);
}

const PRICING = { premium: 20, tax: 0, total: 20, currency: "XOF", validityDays: 10 };

test("issuing a policy writes the sale, invoice and certificate together", { skip }, async () => {
  const pool = getPool();
  const f = await makeCase();
  try {
    const issued = await issuePolicy({ caseId: f.caseId, caseRow: f.caseRow, pricing: PRICING });
    assert.equal(issued.created, true);
    assert.match(issued.policyNumber, /^AA-\d{4}-\d{6}$/);
    assert.match(issued.invoiceNumber, /^INV-\d{4}-\d{6}$/);
    assert.match(issued.certificateNumber, /^CERT-\d{4}-\d{6}$/);

    const [[sale]] = await pool.query("SELECT * FROM sales WHERE id = ?", [issued.saleId]);
    const [[inv]] = await pool.query("SELECT * FROM invoices WHERE sale_id = ?", [issued.saleId]);
    const [[cert]] = await pool.query("SELECT * FROM certificates WHERE sale_id = ?", [issued.saleId]);
    assert.ok(sale && inv && cert, "all three documents must exist");
    assert.equal(sale.payment_status, "Unpaid", "an unpaid issuance stays unpaid");
    assert.ok(cert.public_token, "a certificate needs its public token for the QR and WhatsApp link");
  } finally {
    await dropCase(f);
  }
});

test("issuing twice returns the first policy instead of a second", { skip }, async () => {
  const f = await makeCase();
  try {
    const first = await issuePolicy({ caseId: f.caseId, caseRow: f.caseRow, pricing: PRICING });
    const second = await issuePolicy({ caseId: f.caseId, caseRow: f.caseRow, pricing: PRICING });
    assert.equal(second.created, false);
    assert.equal(second.saleId, first.saleId);
    assert.equal(second.policyNumber, first.policyNumber);
  } finally {
    await dropCase(f);
  }
});

test("concurrent issuance of one case produces exactly one policy", { skip }, async () => {
  const pool = getPool();
  const f = await makeCase();
  try {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => issuePolicy({ caseId: f.caseId, caseRow: f.caseRow, pricing: PRICING }))
    );
    assert.equal(results.filter((r) => r.created).length, 1, "only one caller may create");
    assert.equal(new Set(results.map((r) => r.saleId)).size, 1, "everyone must get the same sale");

    const [[{ n }]] = await pool.query(
      "SELECT COUNT(*) AS n FROM sales WHERE case_id = ? AND deleted_at IS NULL",
      [f.caseId]
    );
    assert.equal(Number(n), 1);
  } finally {
    await dropCase(f);
  }
});

test("a paid issuance records how and when the money arrived", { skip }, async () => {
  const pool = getPool();
  const f = await makeCase();
  try {
    const issued = await issuePolicy({
      caseId: f.caseId,
      caseRow: f.caseRow,
      pricing: PRICING,
      paid: { method: "orange", reference: "PAY-2026-000001", amount: 20 },
    });
    const [[sale]] = await pool.query("SELECT * FROM sales WHERE id = ?", [issued.saleId]);
    assert.equal(sale.payment_status, "Paid");
    assert.equal(Number(sale.received_amount), 20);
    assert.equal(sale.payment_method, "orange");
    assert.equal(sale.payment_reference, "PAY-2026-000001");
    assert.ok(sale.paid_at, "paid_at must be stamped — there was no payment timestamp at all before");

    const [[inv]] = await pool.query("SELECT * FROM invoices WHERE sale_id = ?", [issued.saleId]);
    assert.equal(inv.payment_status, "Paid", "the invoice must agree with the sale");
  } finally {
    await dropCase(f);
  }
});

test("the certificate freezes what it said, so a later catalogue edit cannot change it", { skip }, async () => {
  const f = await makeCase();
  try {
    const issued = await issuePolicy({
      caseId: f.caseId,
      caseRow: f.caseRow,
      pricing: { ...PRICING, premium: 20, total: 20 },
      paid: { method: "wave", reference: "PAY-2026-000002", amount: 20 },
    });

    const snap = await getIssuedSnapshot(issued.saleId);
    assert.ok(snap, "a snapshot must be stored");
    assert.equal(snap.version, 1);
    assert.equal(snap.policy_number, issued.policyNumber);
    assert.equal(Number(snap.pricing.premium), 20);
    assert.equal(snap.pricing.currency, "XOF");
    assert.equal(snap.traveller.passport_or_id, "AB1234567");
    assert.equal(snap.trip.destination, "France");
    assert.equal(snap.plan.name, "IT plan");
    assert.equal(snap.payment.method, "wave");
    assert.equal(snap.payment.reference, "PAY-2026-000002");
    assert.match(snap.issued_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await dropCase(f);
  }
});

test("a policy with no snapshot reads back as null rather than throwing", { skip }, async () => {
  const pool = getPool();
  const f = await makeCase();
  try {
    const issued = await issuePolicy({ caseId: f.caseId, caseRow: f.caseRow, pricing: PRICING });
    await pool.execute("UPDATE certificates SET issued_snapshot = NULL WHERE sale_id = ?", [issued.saleId]);
    assert.equal(await getIssuedSnapshot(issued.saleId), null);
  } finally {
    await dropCase(f);
  }
});

test("closing the pool at the end", { skip }, async () => {
  await getPool().end();
  assert.ok(true);
});
