// tests/integration/passportPrivacy.integration.test.mjs
//
// Passport numbers after the plaintext column has been cleared.
//
// WHY THIS FILE EXISTS. The m3_08 migration encrypts passport numbers and
// `encrypt:passports --clear` empties the old plaintext column. Three read and
// write paths were never wired to the encrypted column, and every one of them
// looked perfectly correct right up until the clear — because the plaintext was
// still sitting there being returned. The admin case list went blank on a live
// database, which is exactly the kind of bug a test that only runs before the
// clear cannot see.
//
// So each test here CLEARS the plaintext column first, then asserts. That is the
// state the production database is in, and it is the only state worth testing.
//
// OPT-IN: set IT_DB_NAME to a throwaway database.
//
import test from "node:test";
import assert from "node:assert/strict";

import { initializePool, getPool } from "../../utils/db.js";
import {
  createTraveller,
  createCase,
  getCaseDetailsById,
  getAllCasesWithPagination,
  updateCaseAndTraveller,
} from "../../models/caseModel.js";
import { getQuoteByReference } from "../../models/quoteModel.js";
import { encryptionReady, passportHash, normalisePassport } from "../../utils/travellerPrivacy.js";

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
const PASSPORT = "CI-9988 776";

const made = { users: [], plans: [], travellers: [], cases: [] };

async function makeCase(passport = PASSPORT) {
  const pool = getPool();
  const [u] = await pool.execute(
    `INSERT INTO users (name, email, password, role) VALUES (?, ?, 'x', 'admin')`,
    ["IT privacy", `${uniq("priv")}@example.test`]
  );
  made.users.push(u.insertId);
  const [p] = await pool.execute(
    `INSERT INTO catalogue (product_type, name, coverage) VALUES ('Travel', ?, 'Medical')`,
    [uniq("IT plan")]
  );
  made.plans.push(p.insertId);

  // createTraveller is the real write path — it encrypts.
  const travellerId = await createTraveller({
    first_name: "Aya",
    last_name: uniq("Kone"),
    date_of_birth: "1988-06-02",
    country_of_residence: "Côte d'Ivoire",
    gender: "Female",
    nationality: "Côte d'Ivoire",
    passport_or_id: passport,
    phone: "+2250700000000",
    email: `${uniq("aya")}@example.test`,
    address: "Abidjan",
  });
  made.travellers.push(travellerId);

  const caseId = await createCase({
    traveller_id: travellerId,
    destination: "France",
    start_date: "2026-11-01",
    end_date: "2026-11-10",
    selected_plan_id: p.insertId,
    created_by: u.insertId,
    status: "Confirmed",
  });
  made.cases.push(caseId);

  return { caseId, travellerId, planId: p.insertId, userId: u.insertId };
}

/** What `npm run encrypt:passports:clear` does to the live database. */
async function clearPlaintext(travellerId) {
  await getPool().execute(
    `UPDATE travellers SET passport_or_id = NULL WHERE id = ? AND passport_or_id_enc IS NOT NULL`,
    [travellerId]
  );
}

test("the test database has an encryption key, or these prove nothing", { skip }, () => {
  assert.equal(encryptionReady(), true, "set SETTINGS_ENCRYPTION_KEY to run this suite");
});

test("the write path stores ciphertext and no plaintext", { skip }, async () => {
  const f = await makeCase();
  const [[row]] = await getPool().query(
    `SELECT passport_or_id, passport_or_id_enc, passport_or_id_hash FROM travellers WHERE id = ?`,
    [f.travellerId]
  );
  assert.equal(row.passport_or_id, null, "nothing new should ever be written in the clear");
  assert.match(row.passport_or_id_enc, /^v1\./, "ciphertext envelope");
  assert.equal(row.passport_or_id_hash, passportHash(PASSPORT), "blind index written");
});

test("the case detail still shows the passport after the plaintext is cleared", { skip }, async () => {
  const f = await makeCase();
  await clearPlaintext(f.travellerId);
  const details = await getCaseDetailsById(f.caseId);
  assert.equal(details.passport_or_id, PASSPORT);
});

test("THE LIVE BUG: the paginated case list still shows the passport", { skip }, async () => {
  const f = await makeCase();
  await clearPlaintext(f.travellerId);

  const page = await getAllCasesWithPagination({ page: 1, limit: 200 });
  const row = page.cases.find((c) => c.id === f.caseId);
  assert.ok(row, "the case should be in the listing");
  assert.equal(
    row.passport_or_id,
    PASSPORT,
    "this is what went blank in production — the list selected the ciphertext and never decrypted it"
  );
  assert.ok(!String(row.passport_or_id).startsWith("v1."), "and it must not be raw ciphertext either");
});

test("the partner quote endpoint still shows the passport", { skip }, async () => {
  const f = await makeCase();
  const reference = uniq("QT").toUpperCase();
  await getPool().execute(`UPDATE cases SET quote_reference = ? WHERE id = ?`, [reference, f.caseId]);
  await clearPlaintext(f.travellerId);

  const quote = await getQuoteByReference(reference);
  assert.ok(quote, "the quote should be found");
  assert.equal(quote.passport_or_id, PASSPORT);
});

test("correcting a passport number actually takes effect", { skip }, async () => {
  const f = await makeCase();
  await clearPlaintext(f.travellerId);

  const before = await getCaseDetailsById(f.caseId);
  const CORRECTED = "CI-1234567";
  assert.notEqual(normalisePassport(CORRECTED), normalisePassport(PASSPORT));

  await updateCaseAndTraveller(
    f.caseId,
    {
      first_name: before.first_name,
      last_name: before.last_name,
      date_of_birth: before.date_of_birth,
      country_of_residence: before.country_of_residence,
      gender: before.gender,
      nationality: before.nationality,
      passport_or_id: CORRECTED,
      phone: before.phone,
      email: before.email,
      address: before.address,
    },
    {
      destination: "France",
      start_date: "2026-11-01",
      end_date: "2026-11-10",
      selected_plan_id: f.planId,
    }
  );

  // Reads prefer the ciphertext. Writing only the plaintext column would have
  // left the old number in place and the correction would vanish.
  const after = await getCaseDetailsById(f.caseId);
  assert.equal(after.passport_or_id, CORRECTED, "the correction must be what reads back");

  const page = await getAllCasesWithPagination({ page: 1, limit: 200 });
  const listed = page.cases.find((c) => c.id === f.caseId);
  assert.equal(listed.passport_or_id, CORRECTED, "and the list must agree with the detail");

  const [[row]] = await getPool().query(
    `SELECT passport_or_id, passport_or_id_enc, passport_or_id_hash FROM travellers WHERE id = ?`,
    [f.travellerId]
  );
  assert.equal(row.passport_or_id, null, "an edit must not put the number back in the clear");
  assert.match(row.passport_or_id_enc, /^v1\./);
  assert.equal(row.passport_or_id_hash, passportHash(CORRECTED), "the blind index must follow the edit");
});

test("clearing an empty passport does not invent one", { skip }, async () => {
  const f = await makeCase(null);
  const details = await getCaseDetailsById(f.caseId);
  assert.ok(details.passport_or_id === null || details.passport_or_id === "", "no passport stays no passport");
});

test("cleaning up", { skip }, async () => {
  const pool = getPool();
  const inList = (arr) => arr.map(() => "?").join(",");
  if (made.cases.length) await pool.query(`DELETE FROM cases WHERE id IN (${inList(made.cases)})`, made.cases);
  if (made.travellers.length) await pool.query(`DELETE FROM travellers WHERE id IN (${inList(made.travellers)})`, made.travellers);
  if (made.plans.length) await pool.query(`DELETE FROM catalogue WHERE id IN (${inList(made.plans)})`, made.plans);
  if (made.users.length) await pool.query(`DELETE FROM users WHERE id IN (${inList(made.users)})`, made.users);
  await pool.end();
  assert.ok(true);
});
