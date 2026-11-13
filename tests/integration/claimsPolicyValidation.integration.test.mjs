// tests/integration/claimsPolicyValidation.integration.test.mjs
//
// Milestone 4, Day 2 against a real database: finding a policy from what the
// customer typed, proving it is theirs, and throttling anyone who guesses.
//
// Fixtures are real issued policies (issuePolicy, the same path a WhatsApp
// purchase takes) with passports stored the way production stores them now —
// encrypted, with a blind index, no plaintext.
//
// OPT-IN: set IT_DB_NAME to a throwaway database that has been migrated.
//
import test from "node:test";
import assert from "node:assert/strict";

import { initializePool, getPool } from "../../utils/db.js";
import { issuePolicy } from "../../models/policyIssuance.js";
import { passportColumns, passportHash } from "../../utils/travellerPrivacy.js";
import {
  validatePolicy, findPolicyCandidates, checkValidationLock, claimPolicySnapshot, identifierHash,
} from "../../models/claimPolicyLookup.js";

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
const wa = () => `2250${RUN}${String(++seq).padStart(3, "0")}`;
const numbersUsed = [];
const nextWa = () => { const n = wa(); numbersUsed.push(n); return n; };

const CONFIG = {
  cardNumberMode: "certificate", cardNumberPattern: "", expiryRule: "incident_date", filingWindowDays: "",
  unpaidPolicies: "allow_flag", uncoveredClaimType: "flag", maxAttempts: 3, lockoutMinutes: 30, maxPerPolicy: 5,
};

const ymd = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function makePolicy({ passport, start = ymd(-10), end = ymd(20), paid = true, guarantees = ["hospitalization", "medicalEmergencies"] } = {}) {
  const pool = getPool();
  const [u] = await pool.execute(
    `INSERT INTO users (name, email, password, role) VALUES ('IT claims', ?, 'x', 'admin')`,
    [`claims-${RUN}-${++seq}@example.test`]
  );
  const planName = `IT Claims Plan ${RUN}-${seq}`;
  const [p] = await pool.execute(
    `INSERT INTO catalogue (product_type, name, coverage, pricing_rules) VALUES ('Travel', ?, 'Medical', ?)`,
    [planName, JSON.stringify({ guarantees: guarantees.map((g) => ({ coverageType: g, category: "MEDICAL", amount: 1000 })) })]
  );
  const cols = passportColumns(passport);
  const [t] = await pool.execute(
    `INSERT INTO travellers (first_name, last_name, date_of_birth, nationality, passport_or_id, passport_or_id_enc, passport_or_id_hash)
     VALUES ('AWA', 'KONE', '1990-05-05', 'Côte d''Ivoire', ?, ?, ?)`,
    [cols.passport_or_id, cols.passport_or_id_enc, cols.passport_or_id_hash]
  );
  const [c] = await pool.execute(
    `INSERT INTO cases (traveller_id, destination, start_date, end_date, selected_plan_id, created_by, status)
     VALUES (?, 'France', ?, ?, ?, ?, 'Confirmed')`,
    [t.insertId, start, end, p.insertId, u.insertId]
  );
  const issued = await issuePolicy({
    caseId: c.insertId,
    caseRow: {
      id: c.insertId, first_name: "AWA", last_name: "KONE", passport_or_id: passport, date_of_birth: "1990-05-05",
      destination: "France", start_date: start, end_date: end, duration_days: 30,
      plan_id: p.insertId, plan_name: planName, product_type: "Travel", coverage: "Medical", currency: "XOF",
    },
    pricing: { premium: 20000, tax: 0, total: 20000, currency: "XOF", validityDays: 30 },
    paid: paid ? { amount: 20000, method: "test", reference: `IT-${RUN}-${seq}` } : null,
  });
  return { ...issued, caseId: c.insertId, travellerId: t.insertId, planName };
}

async function makeExternal({ passport, start = ymd(-5), end = ymd(25), status = "active", paymentStatus = "unknown", card = null, isTest = 1 } = {}) {
  const cols = passportColumns(passport);
  const number = `EXT-${RUN}-${++seq}`;
  const [r] = await getPool().execute(
    `INSERT INTO external_policies (policy_number, card_number, holder_first_name, holder_last_name, passport_or_id_enc, passport_or_id_hash,
                                    product_name, insurer, start_date, end_date, status, payment_status, guarantee_codes, is_test, source)
     VALUES (?, ?, 'MARIE', 'TOURE', ?, ?, 'Imported Gold', 'Partner Re', ?, ?, ?, ?, ?, ?, 'import')`,
    [number, card, cols.passport_or_id_enc, cols.passport_or_id_hash, start, end, status, paymentStatus, JSON.stringify(["tripCancellation"]), isTest]
  );
  return { id: r.insertId, policyNumber: number, card };
}

const passportNo = () => `PA${RUN}${String(++seq).padStart(3, "0")}`;

/* ----------------------------------------------------------- the happy path */

test("a real policy number + the right passport → identified, with only what the flow needs", { skip }, async () => {
  const pp = passportNo();
  const f = await makePolicy({ passport: pp });
  const r = await validatePolicy({ waNumber: nextWa(), identifier: f.policyNumber.toLowerCase(), passport: ` ${pp.toLowerCase()} `, config: CONFIG });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.policy.saleId, f.saleId);
  assert.equal(r.session.policyNumber, f.policyNumber);
  assert.deepEqual(r.session.guaranteeCodes, ["hospitalization", "medicalEmergencies"]);
  assert.equal(r.session.startDate, ymd(-10), "dates from the issued snapshot");
  assert.ok(!JSON.stringify(r.session).includes(pp), "the session never holds the passport");
  assert.ok(!("_passportRow" in r.policy), "the database row does not leak out");
  const snap = claimPolicySnapshot(r.policy);
  assert.ok(!JSON.stringify(snap).includes(pp), "neither does the claim snapshot");
});

test("the certificate number works too, in 'same as certificate' mode only", { skip }, async () => {
  const pp = passportNo();
  const f = await makePolicy({ passport: pp });
  assert.equal((await validatePolicy({ waNumber: nextWa(), identifier: f.certificateNumber, passport: pp, config: CONFIG })).ok, true);
  const none = await validatePolicy({ waNumber: nextWa(), identifier: f.certificateNumber, passport: pp, config: { ...CONFIG, cardNumberMode: "none" } });
  assert.equal(none.outcome, "not_found");
});

test("dates come from the issued snapshot, not from the case as it is today", { skip }, async () => {
  const pp = passportNo();
  const f = await makePolicy({ passport: pp });
  // Someone moves the case dates without re-issuing: the certificate the
  // customer holds still says the original dates, and that is what they claim on.
  await getPool().execute(`UPDATE cases SET start_date = ?, end_date = ? WHERE id = ?`, [ymd(-400), ymd(-370), f.caseId]);
  const r = await validatePolicy({ waNumber: nextWa(), identifier: f.policyNumber, passport: pp, config: CONFIG });
  assert.equal(r.ok, true);
  assert.equal(r.session.endDate, ymd(20));
});

/* ---------------------------------------------------- what a guesser sees */

test("unknown number and wrong passport look identical to the customer", { skip }, async () => {
  const pp = passportNo();
  const f = await makePolicy({ passport: pp });
  const unknown = await validatePolicy({ waNumber: nextWa(), identifier: "AA-1999-999999", passport: pp, config: CONFIG });
  const wrong = await validatePolicy({ waNumber: nextWa(), identifier: f.policyNumber, passport: "ZZ0000000", config: CONFIG });
  assert.deepEqual(Object.keys(unknown).sort(), Object.keys(wrong).sort());
  assert.equal(unknown.outcome, "not_found");
  assert.equal(wrong.outcome, "not_found");
  assert.equal(unknown.policy, undefined);
  assert.equal(wrong.policy, undefined, "nothing about the real policy comes back");

  // …but we can tell them apart in the log.
  const [rows] = await getPool().query(
    `SELECT outcome FROM claim_validation_attempts WHERE identifier_hash IN (?, ?) ORDER BY id`,
    [identifierHash("AA-1999-999999"), identifierHash(f.policyNumber)]
  );
  assert.deepEqual(rows.map((r) => r.outcome).slice(-2), ["not_found", "mismatch"]);
});

test("the attempts log never holds a policy number or a passport", { skip }, async () => {
  const pp = passportNo();
  const f = await makePolicy({ passport: pp });
  const n = nextWa();
  await validatePolicy({ waNumber: n, identifier: f.policyNumber, passport: pp, config: CONFIG });
  const [rows] = await getPool().query(`SELECT * FROM claim_validation_attempts WHERE wa_number = ?`, [n]);
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes(f.policyNumber));
  assert.ok(!dump.includes(pp));
});

/* ---------------------------------------------------------- throttling */

test("three wrong tries lock the number — and the right answer does not get through the lock", { skip }, async () => {
  const pp = passportNo();
  const f = await makePolicy({ passport: pp });
  const n = nextWa();
  const left = [];
  for (let i = 0; i < 3; i += 1) {
    left.push((await validatePolicy({ waNumber: n, identifier: f.policyNumber, passport: `WRONG${i}`, config: CONFIG })).attemptsLeft);
  }
  assert.deepEqual(left, [2, 1, 0]);
  const blocked = await validatePolicy({ waNumber: n, identifier: f.policyNumber, passport: pp, config: CONFIG });
  assert.equal(blocked.outcome, "locked");
  assert.equal(blocked.scope, "number");
  assert.ok(blocked.retryAfterMinutes >= 1 && blocked.retryAfterMinutes <= 30);
  // Another number is not affected.
  assert.equal((await validatePolicy({ waNumber: nextWa(), identifier: f.policyNumber, passport: pp, config: CONFIG })).ok, true);
});

test("the lock is in the database: a fresh process sees it", { skip }, async () => {
  const n = nextWa();
  for (let i = 0; i < 3; i += 1) {
    await getPool().execute(
      `INSERT INTO claim_validation_attempts (wa_number, identifier_hash, outcome) VALUES (?, ?, 'not_found')`,
      [n, identifierHash(`X${i}`)]
    );
  }
  const lock = await checkValidationLock({ waNumber: n, config: CONFIG });
  assert.equal(lock.locked, true);
});

test("the lock lifts when the lockout period has passed", { skip }, async () => {
  const n = nextWa();
  for (let i = 0; i < 3; i += 1) {
    await getPool().execute(
      `INSERT INTO claim_validation_attempts (wa_number, identifier_hash, outcome, created_at) VALUES (?, ?, 'mismatch', NOW() - INTERVAL 31 MINUTE)`,
      [n, identifierHash(`Y${i}`)]
    );
  }
  assert.equal((await checkValidationLock({ waNumber: n, config: CONFIG })).locked, false);
});

test("one policy guessed at from many numbers is locked for everyone", { skip }, async () => {
  const pp = passportNo();
  const f = await makePolicy({ passport: pp });
  for (let i = 0; i < 5; i += 1) {
    await validatePolicy({ waNumber: nextWa(), identifier: f.policyNumber, passport: `GUESS${i}`, config: CONFIG });
  }
  const r = await validatePolicy({ waNumber: nextWa(), identifier: f.policyNumber, passport: pp, config: CONFIG });
  assert.equal(r.outcome, "locked");
  assert.equal(r.scope, "policy");
});

test("successful and legitimate refusals never count towards a lock", { skip }, async () => {
  const pp = passportNo();
  const f = await makePolicy({ passport: pp });
  const n = nextWa();
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await validatePolicy({ waNumber: n, identifier: f.policyNumber, passport: pp, config: CONFIG })).ok, true);
  }
});

/* -------------------------------------------------------- policy status */

test("cancelled (soft-deleted) policy: identified, then refused with the reason", { skip }, async () => {
  const pp = passportNo();
  const f = await makePolicy({ passport: pp });
  await getPool().execute(`UPDATE sales SET deleted_at = NOW() WHERE id = ?`, [f.saleId]);
  const r = await validatePolicy({ waNumber: nextWa(), identifier: f.policyNumber, passport: pp, config: CONFIG });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.policy.policyNumber, f.policyNumber, "identity proven — safe to say which policy");
});

test("unpaid policy: flagged by default, refused when the setting says so", { skip }, async () => {
  const pp = passportNo();
  const f = await makePolicy({ passport: pp, paid: false });
  const flagged = await validatePolicy({ waNumber: nextWa(), identifier: f.policyNumber, passport: pp, config: CONFIG });
  assert.equal(flagged.ok, true);
  assert.deepEqual(flagged.flags, ["unpaid_policy"]);
  const refused = await validatePolicy({ waNumber: nextWa(), identifier: f.policyNumber, passport: pp, config: { ...CONFIG, unpaidPolicies: "refuse" } });
  assert.equal(refused.outcome, "unpaid");
});

test("expired policy: allowed under the incident-date rule, refused under the today rule", { skip }, async () => {
  const pp = passportNo();
  const f = await makePolicy({ passport: pp, start: ymd(-60), end: ymd(-30) });
  const ok = await validatePolicy({ waNumber: nextWa(), identifier: f.policyNumber, passport: pp, config: CONFIG });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.flags, ["policy_expired_since"]);
  const today = await validatePolicy({ waNumber: nextWa(), identifier: f.policyNumber, passport: pp, config: { ...CONFIG, expiryRule: "today" } });
  assert.equal(today.outcome, "expired");
  assert.equal(today.endDate, ymd(-30));
  const late = await validatePolicy({ waNumber: nextWa(), identifier: f.policyNumber, passport: pp, config: { ...CONFIG, filingWindowDays: 15 } });
  assert.equal(late.outcome, "out_of_window");
});

/* --------------------------------------------------- imported policies */

test("an imported policy is found by its number and by its card number", { skip }, async () => {
  const pp = passportNo();
  const e = await makeExternal({ passport: pp, card: `CARD${RUN}${seq}` });
  const byNumber = await validatePolicy({ waNumber: nextWa(), identifier: e.policyNumber, passport: pp, config: CONFIG });
  assert.equal(byNumber.ok, true, JSON.stringify(byNumber));
  assert.equal(byNumber.policy.source, "external");
  assert.equal(byNumber.policy.externalPolicyId, e.id);
  assert.equal(byNumber.session.isTest, true, "test policies are marked so their claims are too");
  assert.deepEqual(byNumber.flags, [], "unknown payment is not 'unpaid'");
  const byCard = await validatePolicy({ waNumber: nextWa(), identifier: e.card, passport: pp, config: CONFIG });
  assert.equal(byCard.ok, true);
});

test("separate card mode: a card-shaped number is looked up only as a card", { skip }, async () => {
  const pp = passportNo();
  const card = `SC${RUN}${String(seq).padStart(4, "0")}`;
  const e = await makeExternal({ passport: pp, card });
  const cfg = { ...CONFIG, cardNumberMode: "separate", cardNumberPattern: "^SC[0-9]+$" };
  const cands = await findPolicyCandidates(card, cfg);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].externalPolicyId, e.id);
  assert.equal((await validatePolicy({ waNumber: nextWa(), identifier: card, passport: pp, config: cfg })).ok, true);
});

test("a cancelled imported policy is refused like any other", { skip }, async () => {
  const pp = passportNo();
  const e = await makeExternal({ passport: pp, status: "cancelled" });
  const r = await validatePolicy({ waNumber: nextWa(), identifier: e.policyNumber, passport: pp, config: CONFIG });
  assert.equal(r.outcome, "cancelled");
});

/* ------------------------------------------------------- live data rule */

test("validation writes nothing to sales, cases, travellers or certificates", { skip }, async () => {
  const pp = passportNo();
  const f = await makePolicy({ passport: pp });
  const read = async () => {
    const [[s]] = await getPool().query(`SELECT * FROM sales WHERE id = ?`, [f.saleId]);
    const [[c]] = await getPool().query(`SELECT * FROM cases WHERE id = ?`, [f.caseId]);
    const [[t]] = await getPool().query(`SELECT * FROM travellers WHERE id = ?`, [f.travellerId]);
    const [[cert]] = await getPool().query(`SELECT * FROM certificates WHERE sale_id = ?`, [f.saleId]);
    return JSON.stringify([s, c, t, cert]);
  };
  const before = await read();
  await validatePolicy({ waNumber: nextWa(), identifier: f.policyNumber, passport: pp, config: CONFIG });
  await validatePolicy({ waNumber: nextWa(), identifier: f.policyNumber, passport: "WRONG", config: CONFIG });
  assert.equal(await read(), before);
  assert.equal(typeof passportHash, "function");
});

test.after(async () => {
  if (!CONFIGURED) return;
  await getPool().query(`DELETE FROM claim_validation_attempts WHERE wa_number IN (?)`, [numbersUsed.length ? numbersUsed : ["-"]]);
  await getPool().end();
});
