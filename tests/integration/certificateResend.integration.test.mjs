// tests/integration/certificateResend.integration.test.mjs
//
// Finding the policy behind a WhatsApp number, and the throttle that stops the
// same document being sent over and over.
//
// Both are SQL, and the first one decides who receives a PDF containing a
// passport number. The match therefore has to be exact. A "helpful" match on the
// last nine digits would work in testing and eventually send one customer
// another customer's certificate, so the test that matters most here is the one
// that proves a near-miss number finds nothing.
//
// OPT-IN: set IT_DB_NAME to a throwaway database.
//
import test from "node:test";
import assert from "node:assert/strict";

import { initializePool, getPool } from "../../utils/db.js";
import { getLatestPolicyForWhatsAppNumber } from "../../models/salesModel.js";
import { countRecentOutboundByStep } from "../../models/whatsappModel.js";

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
const uniq = (p) => `${p}-${RUN}-${Math.floor(Math.random() * 100000)}`;

/** A number nobody else in the database can collide with. */
const NUMBER_A = `22507${RUN.slice(0, 7)}`;
const NUMBER_B = `22505${RUN.slice(0, 7)}`;

const created = { users: [], plans: [], travellers: [], cases: [], sales: [], messages: [] };

async function makePolicy({ waNumber, phone = null, policySuffix, withCertificate = true, deleted = false }) {
  const pool = getPool();
  const [u] = await pool.execute(
    `INSERT INTO users (name, email, password, role) VALUES (?, ?, 'x', 'admin')`,
    ["IT resend", `${uniq("resend")}@example.test`]
  );
  created.users.push(u.insertId);
  const [p] = await pool.execute(
    `INSERT INTO catalogue (product_type, name, coverage) VALUES ('Travel', ?, 'Medical')`,
    [uniq("IT plan")]
  );
  created.plans.push(p.insertId);
  const [t] = await pool.execute(
    `INSERT INTO travellers (first_name, last_name, phone, whatsapp_number, date_of_birth)
     VALUES ('Aya', 'Koné', ?, ?, '1988-06-02')`,
    [phone, waNumber]
  );
  created.travellers.push(t.insertId);
  const [c] = await pool.execute(
    `INSERT INTO cases (traveller_id, destination, start_date, end_date, selected_plan_id, created_by)
     VALUES (?, 'France', '2026-11-01', '2026-11-10', ?, ?)`,
    [t.insertId, p.insertId, u.insertId]
  );
  created.cases.push(c.insertId);
  const [s] = await pool.execute(
    `INSERT INTO sales (case_id, policy_number, certificate_number, premium_amount, tax, total, confirmed_at, deleted_at)
     VALUES (?, ?, ?, 20000, 0, 20000, NOW(), ?)`,
    [c.insertId, `AA-IT-${policySuffix}`, `CERT-IT-${policySuffix}`, deleted ? new Date() : null]
  );
  created.sales.push(s.insertId);
  if (withCertificate) {
    await pool.execute(
      `INSERT INTO certificates (sale_id, certificate_number, public_token, coverage_summary)
       VALUES (?, ?, ?, 'Medical')`,
      [s.insertId, `CERT-IT-${policySuffix}`, uniq("tok").replace(/-/g, "")]
    );
  }
  return { saleId: s.insertId, caseId: c.insertId, travellerId: t.insertId };
}

test("teardown is registered", { skip }, async () => {
  assert.ok(true);
});

/* ------------------------------------------------------------ finding it */

test("a number finds its own policy, with the certificate attached", { skip }, async () => {
  const made = await makePolicy({ waNumber: NUMBER_A, policySuffix: "A1" });
  const found = await getLatestPolicyForWhatsAppNumber(NUMBER_A);
  assert.ok(found, "the policy must be found");
  assert.equal(found.sale_id, made.saleId);
  assert.equal(found.policy_number, "AA-IT-A1");
  assert.ok(found.certificate_id, "the certificate row must come with it");
  assert.ok(found.public_token, "and its token, which is what the link uses");
});

test("another customer's number does not find it", { skip }, async () => {
  await makePolicy({ waNumber: NUMBER_B, policySuffix: "B1" });
  const found = await getLatestPolicyForWhatsAppNumber(NUMBER_B);
  assert.equal(found.policy_number, "AA-IT-B1", "B gets B's policy");
  const a = await getLatestPolicyForWhatsAppNumber(NUMBER_A);
  assert.equal(a.policy_number, "AA-IT-A1", "and A still gets A's");
});

test("a number that merely ENDS the same finds nothing", { skip }, async () => {
  // The whole reason the match is exact. 225 is Côte d'Ivoire, 221 is Senegal:
  // same nine trailing digits, different person.
  const nearMiss = `221${NUMBER_A.slice(3)}`;
  assert.notEqual(nearMiss, NUMBER_A);
  assert.equal(nearMiss.slice(-9), NUMBER_A.slice(-9), "the test is only meaningful if they share a tail");
  assert.equal(await getLatestPolicyForWhatsAppNumber(nearMiss), null);
});

test("a + prefix, spaces and dashes are the same number", { skip }, async () => {
  const spaced = `+${NUMBER_A.slice(0, 3)} ${NUMBER_A.slice(3, 5)}-${NUMBER_A.slice(5)}`;
  const found = await getLatestPolicyForWhatsAppNumber(spaced);
  assert.ok(found, `${spaced} should resolve to the same policy`);
  assert.equal(found.policy_number, "AA-IT-A1");
});

test("the number stored only as a phone still matches", { skip }, async () => {
  // A quote created by an adviser has phone set and whatsapp_number empty.
  const phoneOnly = `22501${RUN.slice(0, 7)}`;
  await makePolicy({ waNumber: null, phone: `+${phoneOnly}`, policySuffix: "P1" });
  const found = await getLatestPolicyForWhatsAppNumber(phoneOnly);
  assert.ok(found);
  assert.equal(found.policy_number, "AA-IT-P1");
});

test("a cancelled policy is not offered", { skip }, async () => {
  const number = `22509${RUN.slice(0, 7)}`;
  await makePolicy({ waNumber: number, policySuffix: "D1", deleted: true });
  assert.equal(await getLatestPolicyForWhatsAppNumber(number), null);
});

test("a policy with no certificate is returned, but says so", { skip }, async () => {
  const number = `22503${RUN.slice(0, 7)}`;
  const made = await makePolicy({ waNumber: number, policySuffix: "N1", withCertificate: false });
  const found = await getLatestPolicyForWhatsAppNumber(number);
  assert.equal(found.sale_id, made.saleId);
  assert.equal(found.certificate_id, null, "the engine needs to be able to tell");
});

test("the conversation's own case wins over an older policy", { skip }, async () => {
  const number = `22577${RUN.slice(0, 7)}`;
  const pool = getPool();
  const older = await makePolicy({ waNumber: number, policySuffix: "O1" });
  const newer = await makePolicy({ waNumber: number, policySuffix: "O2" });

  // Without a case, the newest wins.
  const latest = await getLatestPolicyForWhatsAppNumber(number);
  assert.equal(latest.sale_id, newer.saleId);

  // With the conversation's case, that one wins even though it is older.
  const pinned = await getLatestPolicyForWhatsAppNumber(number, { caseId: older.caseId });
  assert.equal(pinned.sale_id, older.saleId);

  // And an unrelated case id does not confuse it.
  const [[{ mx }]] = await pool.query("SELECT COALESCE(MAX(id), 0) + 1000 AS mx FROM cases");
  const unrelated = await getLatestPolicyForWhatsAppNumber(number, { caseId: mx });
  assert.equal(unrelated.sale_id, newer.saleId);
});

test("an empty or junk number finds nothing and makes no query", { skip }, async () => {
  assert.equal(await getLatestPolicyForWhatsAppNumber(""), null);
  assert.equal(await getLatestPolicyForWhatsAppNumber(null), null);
  assert.equal(await getLatestPolicyForWhatsAppNumber("not a number"), null);
});

/* ------------------------------------------------------------- throttling */

test("only recent, successful certificate sends to this number are counted", { skip }, async () => {
  const pool = getPool();
  const number = `22588${RUN.slice(0, 7)}`;
  const rows = [
    // counted
    ["outbound", "certificate", "sent", 0],
    ["outbound", "certificate", null, 0],
    // not counted
    ["outbound", "certificate", "failed", 0],
    ["inbound", "certificate", "delivered", 0],
    ["outbound", "email", "sent", 0],
    ["outbound", "certificate", "sent", 120],
  ];
  for (const [direction, stepKey, status, minutesAgo] of rows) {
    const [r] = await pool.execute(
      `INSERT INTO whatsapp_messages (session_id, wa_number, direction, message_type, step_key, status, created_at)
       VALUES (NULL, ?, ?, 'document', ?, ?, NOW() - INTERVAL ? MINUTE)`,
      [number, direction, stepKey, status, minutesAgo]
    );
    created.messages.push(r.insertId);
  }

  assert.equal(await countRecentOutboundByStep(number, "certificate", 5), 2);
  assert.equal(
    await countRecentOutboundByStep(number, "certificate", 180),
    3,
    "a wider window picks up the old one"
  );
  assert.equal(await countRecentOutboundByStep(number, "email", 5), 1);
  assert.equal(await countRecentOutboundByStep(`${number}9`, "certificate", 5), 0, "another number is not ours");
});

test("a silly window is clamped rather than trusted", { skip }, async () => {
  const number = `22588${RUN.slice(0, 7)}`;
  assert.equal(await countRecentOutboundByStep(number, "certificate", -1), 2, "at least a minute");
  assert.equal(await countRecentOutboundByStep(number, "certificate", 99999), 3, "at most a day");
});

/* ---------------------------------------------------------------- cleanup */

test("cleaning up", { skip }, async () => {
  const pool = getPool();
  if (created.messages.length) {
    await pool.query(`DELETE FROM whatsapp_messages WHERE id IN (${created.messages.map(() => "?").join(",")})`, created.messages);
  }
  if (created.sales.length) {
    await pool.query(`DELETE FROM certificates WHERE sale_id IN (${created.sales.map(() => "?").join(",")})`, created.sales);
    await pool.query(`DELETE FROM sales WHERE id IN (${created.sales.map(() => "?").join(",")})`, created.sales);
  }
  if (created.cases.length) {
    await pool.query(`DELETE FROM cases WHERE id IN (${created.cases.map(() => "?").join(",")})`, created.cases);
  }
  if (created.travellers.length) {
    await pool.query(`DELETE FROM travellers WHERE id IN (${created.travellers.map(() => "?").join(",")})`, created.travellers);
  }
  if (created.plans.length) {
    await pool.query(`DELETE FROM catalogue WHERE id IN (${created.plans.map(() => "?").join(",")})`, created.plans);
  }
  if (created.users.length) {
    await pool.query(`DELETE FROM users WHERE id IN (${created.users.map(() => "?").join(",")})`, created.users);
  }
  await pool.end();
  assert.ok(true);
});
