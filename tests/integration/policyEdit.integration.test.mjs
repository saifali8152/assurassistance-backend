// tests/integration/policyEdit.integration.test.mjs
//
// Correcting an issued policy, and what the certificate says afterwards.
//
// THE BUG THIS PINS. An adviser corrected a destination on a confirmed policy.
// The case screen showed the correction. The downloaded certificate showed the
// old destination — beside the NEW dates, because the frozen snapshot was being
// overlaid onto live data one field at a time. So the document was half frozen,
// half current, and disagreed with the screen that produced it.
//
// The resolution is a distinction, not a switch: the CATALOGUE still cannot move
// an issued certificate, and a deliberate, audited policy edit now can. Both
// halves are tested here, because fixing the first by abandoning the second
// would be worse than the bug.
//
// OPT-IN: set IT_DB_NAME to a throwaway database.
//
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { initializePool, getPool } from "../../utils/db.js";
import { issuePolicy, refreshIssuedSnapshot, getIssuedSnapshot } from "../../models/policyIssuance.js";
import { certificatePdfBufferForSaleId, getCertificatePageDataPublic } from "../../controllers/documentController.js";
import { certificateDir, invalidateStoredCertificate } from "../../utils/certificateStore.js";

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

process.env.PUBLIC_API_URL = process.env.PUBLIC_API_URL || "https://api.example.test";

const RUN = Date.now().toString().slice(-9);
const uniq = (p) => `${p}-${RUN}-${Math.floor(Math.random() * 100000)}`;

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "polyedit-"));
const REAL_CWD = process.cwd();
process.chdir(SANDBOX);

const made = { users: [], plans: [], travellers: [], cases: [] };

async function makeIssued({ destination = "Saudi Arabia" } = {}) {
  const pool = getPool();
  const [u] = await pool.execute(
    `INSERT INTO users (name, email, password, role) VALUES (?, ?, 'x', 'admin')`,
    ["IT edit", `${uniq("edit")}@example.test`]
  );
  made.users.push(u.insertId);
  const planName = uniq("GNA Retail");
  const [p] = await pool.execute(
    `INSERT INTO catalogue (product_type, name, coverage) VALUES ('Travel', ?, 'Medical')`,
    [planName]
  );
  made.plans.push(p.insertId);
  const [t] = await pool.execute(
    `INSERT INTO travellers (first_name, last_name, passport_or_id, date_of_birth, nationality)
     VALUES ('SYLLA', 'OROKIA', '25AE05595', '1959-01-01', 'Côte d''Ivoire')`
  );
  made.travellers.push(t.insertId);
  const [c] = await pool.execute(
    `INSERT INTO cases (traveller_id, destination, start_date, end_date, selected_plan_id, created_by, status)
     VALUES (?, ?, '2026-10-18', '2026-12-01', ?, ?, 'Confirmed')`,
    [t.insertId, destination, p.insertId, u.insertId]
  );
  made.cases.push(c.insertId);

  const caseRow = {
    id: c.insertId,
    first_name: "SYLLA", last_name: "OROKIA", passport_or_id: "25AE05595",
    date_of_birth: "1959-01-01", nationality: "Côte d'Ivoire",
    destination, start_date: "2026-10-18", end_date: "2026-12-01", duration_days: 45,
    plan_id: p.insertId, plan_name: planName, product_type: "Travel", coverage: "Medical",
    currency: "XOF",
  };

  const issued = await issuePolicy({
    caseId: c.insertId,
    caseRow,
    pricing: { premium: 30500, tax: 0, total: 30500, currency: "XOF", validityDays: 45 },
  });

  return { ...issued, caseId: c.insertId, planId: p.insertId, planName, caseRow };
}

/** What the admin screen does: change the case. */
async function editDestination(caseId, destination) {
  await getPool().execute(`UPDATE cases SET destination = ? WHERE id = ?`, [destination, caseId]);
}

/** What the policy-edit endpoint now does after saving the case. */
async function reIssue(f, overrides = {}) {
  const result = await refreshIssuedSnapshot({
    saleId: f.saleId,
    caseRow: { ...f.caseRow, ...overrides },
    pricing: { premium: 30500, tax: 0, total: 30500, currency: "XOF", validityDays: 45 },
    reason: "policy_edit",
    byUserId: 1,
  });
  if (result.ok) invalidateStoredCertificate(result.certificateNumber);
  return result;
}

async function publicPayload(saleId) {
  const [[cert]] = await getPool().query(`SELECT public_token FROM certificates WHERE sale_id = ?`, [saleId]);
  let payload = null;
  const res = { status: () => res, json: (b) => { payload = b; return res; }, setHeader: () => res, send: (b) => { payload = b; return res; } };
  await getCertificatePageDataPublic(
    { params: { token: cert.public_token }, query: {}, protocol: "https", get: (h) => (String(h).toLowerCase() === "host" ? "api.example.test" : "") },
    res
  );
  return payload;
}

/* ------------------------------------------------- the reported bug */

test("a corrected destination reaches the certificate", { skip }, async () => {
  const f = await makeIssued({ destination: "Saudi Arabia" });

  const before = await publicPayload(f.saleId);
  assert.equal(before.coverage.destinations, "Saudi Arabia");

  await editDestination(f.caseId, "France");
  const result = await reIssue(f, { destination: "France" });
  assert.equal(result.ok, true);

  const after = await publicPayload(f.saleId);
  assert.equal(after.coverage.destinations, "France", "the correction must print");
  assert.equal(after.issuedFromSnapshot, true, "and it must still be a frozen document");
});

test("the stored PDF is dropped, so the download changes too", { skip }, async () => {
  const f = await makeIssued({ destination: "Saudi Arabia" });

  const first = await certificatePdfBufferForSaleId(f.saleId, null, { locale: "fr" });
  const onDisk = path.join(certificateDir(), `${f.certificateNumber}-fr.pdf`);
  assert.ok(fs.existsSync(onDisk), "the first render is stored");

  await editDestination(f.caseId, "France");
  await reIssue(f, { destination: "France" });

  assert.equal(fs.existsSync(onDisk), false, "a correction must drop the stored document");

  const second = await certificatePdfBufferForSaleId(f.saleId, null, { locale: "fr" });
  assert.equal(second.fromStore, false, "and the next download re-renders");
  assert.notDeepEqual(second.pdfBuffer, first.pdfBuffer, "the bytes must actually differ");
});

/* ------------------------------- what must NOT change: the policy's identity */

test("a correction keeps the policy's numbers and issue date", { skip }, async () => {
  const f = await makeIssued();
  const before = await getIssuedSnapshot(f.saleId);

  await editDestination(f.caseId, "France");
  await reIssue(f, { destination: "France" });
  const after = await getIssuedSnapshot(f.saleId);

  assert.equal(after.policy_number, before.policy_number);
  assert.equal(after.certificate_number, before.certificate_number);
  assert.equal(after.invoice_number, before.invoice_number);
  assert.equal(after.issued_at, before.issued_at, "it is the same policy, issued when it was issued");
  assert.ok(after.revised_at, "but the revision is dated");
});

test("what the certificate used to say is kept", { skip }, async () => {
  const f = await makeIssued({ destination: "Saudi Arabia" });
  await editDestination(f.caseId, "France");
  await reIssue(f, { destination: "France" });

  const snap = await getIssuedSnapshot(f.saleId);
  assert.equal(snap.revisions.length, 1);
  assert.equal(snap.revisions[0].reason, "policy_edit");
  assert.equal(snap.revisions[0].by, 1);
  assert.equal(snap.revisions[0].replaced.trip.destination, "Saudi Arabia", "the superseded value is recoverable");

  await editDestination(f.caseId, "Spain");
  await reIssue(f, { destination: "Spain" });
  const snap2 = await getIssuedSnapshot(f.saleId);
  assert.equal(snap2.revisions.length, 2);
  assert.equal(snap2.revisions[1].replaced.trip.destination, "France");
});

/* ---------------------- what must STILL be impossible: a catalogue edit */

test("renaming the plan still cannot change an issued certificate", { skip }, async () => {
  const f = await makeIssued();
  const before = await publicPayload(f.saleId);

  await getPool().execute(`UPDATE catalogue SET name = 'Renamed after issuance' WHERE id = ?`, [f.planId]);

  const after = await publicPayload(f.saleId);
  assert.equal(after.coverage.planName, f.planName, "the catalogue must not reach an issued document");
  assert.equal(after.coverage.planName, before.coverage.planName);
});

test("a certificate with no snapshot is never frozen by an edit", { skip }, async () => {
  const f = await makeIssued();
  await getPool().execute(`UPDATE certificates SET issued_snapshot = NULL WHERE sale_id = ?`, [f.saleId]);

  const result = await reIssue(f, { destination: "France" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_snapshot", "writing one now would freeze a document that was never frozen");

  const [[cert]] = await getPool().query(`SELECT issued_snapshot FROM certificates WHERE sale_id = ?`, [f.saleId]);
  assert.equal(cert.issued_snapshot, null);
});

/* ------------------------------------------------ the half-frozen document */

test("the document is wholly frozen, never half of each", { skip }, async () => {
  const f = await makeIssued({ destination: "Saudi Arabia" });

  // Change everything the snapshot holds, WITHOUT re-issuing: this is the
  // catalogue-drift case, and the certificate must ignore all of it rather than
  // printing some new values beside some old ones.
  await getPool().execute(
    `UPDATE cases SET destination = 'Spain', start_date = '2027-01-01', end_date = '2027-01-15' WHERE id = ?`,
    [f.caseId]
  );

  const payload = await publicPayload(f.saleId);
  assert.equal(payload.coverage.destinations, "Saudi Arabia");
  assert.equal(payload.coverage.periodFrom, "18/10/2026", "dates must be frozen with the destination");
  assert.equal(payload.coverage.periodTo, "01/12/2026");
});

test("cleaning up", { skip }, async () => {
  const pool = getPool();
  const inList = (a) => a.map(() => "?").join(",");
  if (made.cases.length) {
    await pool.query(`DELETE FROM certificates WHERE sale_id IN (SELECT id FROM sales WHERE case_id IN (${inList(made.cases)}))`, made.cases);
    await pool.query(`DELETE FROM invoices WHERE sale_id IN (SELECT id FROM sales WHERE case_id IN (${inList(made.cases)}))`, made.cases);
    await pool.query(`DELETE FROM sales WHERE case_id IN (${inList(made.cases)})`, made.cases);
    await pool.query(`DELETE FROM cases WHERE id IN (${inList(made.cases)})`, made.cases);
  }
  if (made.travellers.length) await pool.query(`DELETE FROM travellers WHERE id IN (${inList(made.travellers)})`, made.travellers);
  if (made.plans.length) await pool.query(`DELETE FROM catalogue WHERE id IN (${inList(made.plans)})`, made.plans);
  if (made.users.length) await pool.query(`DELETE FROM users WHERE id IN (${inList(made.users)})`, made.users);
  await pool.end();
  process.chdir(REAL_CWD);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  assert.ok(true);
});
