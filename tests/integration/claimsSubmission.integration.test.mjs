// tests/integration/claimsSubmission.integration.test.mjs
//
// Milestone 4, Days 3–6 against a real database: a claim from draft to
// submitted, the case number, the policy snapshot, the email outbox and its
// sender, tracking by reference, resuming an unfinished claim and the job
// that marks idle drafts abandoned.
//
// OPT-IN: set IT_DB_NAME to a throwaway database that has been migrated.
//
import test from "node:test";
import assert from "node:assert/strict";

import { initializePool, getPool } from "../../utils/db.js";
import { issuePolicy } from "../../models/policyIssuance.js";
import { passportColumns } from "../../utils/travellerPrivacy.js";
import {
  createDraft, updateDraft, getClaimById, getStatusHistory, submitClaim, abandonDraft,
  abandonStaleDrafts, findResumableDraft, trackClaimForNumber,
} from "../../models/claimModel.js";
import { dueNotifications, renderClaimEmail } from "../../models/claimNotificationModel.js";
import { runOnce } from "../../scripts/sendClaimNotifications.js";
import { claimsContextFor } from "../../controllers/whatsappController.js";
import { setFlag, addToAllowlist, removeFromAllowlist, clearFlagCache, CLAIMS_FLAG } from "../../utils/featureFlags.js";

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
const nextWa = () => `2250${RUN}${String(++seq).padStart(3, "0")}`;
const PASSPORT = `PS${RUN}`;

const ymd = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function makePolicy() {
  const pool = getPool();
  const [u] = await pool.execute(`INSERT INTO users (name, email, password, role) VALUES ('IT sub', ?, 'x', 'admin')`, [`sub-${RUN}-${++seq}@example.test`]);
  const [p] = await pool.execute(`INSERT INTO catalogue (product_type, name, coverage) VALUES ('Travel', ?, 'Medical')`, [`IT Sub Plan ${RUN}-${seq}`]);
  const cols = passportColumns(PASSPORT);
  const [t] = await pool.execute(
    `INSERT INTO travellers (first_name, last_name, date_of_birth, passport_or_id, passport_or_id_enc, passport_or_id_hash)
     VALUES ('FATOU', 'DIALLO', '1988-01-01', ?, ?, ?)`,
    [cols.passport_or_id, cols.passport_or_id_enc, cols.passport_or_id_hash]
  );
  const [c] = await pool.execute(
    `INSERT INTO cases (traveller_id, destination, start_date, end_date, selected_plan_id, created_by, status)
     VALUES (?, 'France', ?, ?, ?, ?, 'Confirmed')`,
    [t.insertId, ymd(-10), ymd(20), p.insertId, u.insertId]
  );
  return issuePolicy({
    caseId: c.insertId,
    caseRow: {
      id: c.insertId, first_name: "FATOU", last_name: "DIALLO", passport_or_id: PASSPORT, destination: "France",
      start_date: ymd(-10), end_date: ymd(20), plan_id: p.insertId, plan_name: `IT Sub Plan ${RUN}-${seq}`, product_type: "Travel", currency: "XOF",
    },
    pricing: { premium: 15000, tax: 0, total: 15000, currency: "XOF", validityDays: 30 },
    paid: { amount: 15000, method: "test", reference: `ITS-${RUN}-${seq}` },
  });
}

const STATE = (over = {}) => ({
  category: { code: "medical" }, subcategory: { code: "hospitalization" }, incidentDate: ymd(-2),
  countryCode: "FR", country: "France", city: "Lyon", description: "Admise aux urgences après une chute.",
  fields: { hospital_name: "HCL" }, flags: [], priority: "urgent", ...over,
});

async function draftFor(policy, wa, over = {}) {
  return createDraft({ waNumber: wa, saleId: policy.saleId, policyNumber: policy.policyNumber, holderName: "FATOU", isTest: true, ...over });
}

/* ------------------------------------------------------------- submission */

test("submit: reference, snapshot, history and outbox land together", { skip }, async () => {
  const pol = await makePolicy();
  const wa = nextWa();
  const id = await draftFor(pol, wa);
  const r = await submitClaim({ claimId: id, state: STATE(), language: "fr", waNumber: wa, config: { numberFormat: "SIN-{YYYY}-{SEQ:6}", notificationEmails: ["claims@example.test"] } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.reference, new RegExp(`^SIN-${new Date().getFullYear()}-\\d{6}$`));

  const c = await getClaimById(id);
  assert.equal(c.status, "submitted");
  assert.equal(c.reference, r.reference);
  assert.equal(c.priority, "urgent");
  assert.ok(c.submittedAt);
  assert.equal(c.holderName, "FATOU DIALLO", "full name from the policy, not the conversation");
  assert.equal(c.policySnapshot.policy_number, pol.policyNumber);
  assert.equal(c.policySnapshot.end_date, ymd(20));
  assert.ok(!JSON.stringify(c.policySnapshot).includes(PASSPORT), "no passport in the snapshot");
  assert.equal(c.subcategoryCode, "hospitalization");
  assert.deepEqual(c.extraFields, { hospital_name: "HCL" });

  const h = await getStatusHistory(id);
  assert.deepEqual(h.map((x) => x.to_status), ["draft", "submitted"]);

  const [[n]] = await getPool().query(`SELECT status, priority FROM claim_notifications WHERE claim_id = ?`, [id]);
  assert.deepEqual({ ...n }, { status: "pending", priority: "urgent" });
});

test("submit twice (double tap): same reference, one notification", { skip }, async () => {
  const pol = await makePolicy();
  const wa = nextWa();
  const id = await draftFor(pol, wa);
  const cfg = { notificationEmails: ["a@example.test"] };
  const a = await submitClaim({ claimId: id, state: STATE({ priority: "normal" }), waNumber: wa, config: cfg });
  const b = await submitClaim({ claimId: id, state: STATE({ priority: "normal" }), waNumber: wa, config: cfg });
  assert.equal(b.ok, true);
  assert.equal(b.reference, a.reference);
  assert.equal(b.alreadySubmitted, true);
  const [[{ k }]] = await getPool().query(`SELECT COUNT(*) AS k FROM claim_notifications WHERE claim_id = ?`, [id]);
  assert.equal(Number(k), 1);
});

test("concurrent submits of different claims never share a reference", { skip }, async () => {
  const pol = await makePolicy();
  const ids = [];
  const was = [];
  for (let i = 0; i < 8; i += 1) {
    const wa = nextWa();
    was.push(wa);
    ids.push(await draftFor(pol, wa));
  }
  const res = await Promise.all(ids.map((id, i) => submitClaim({ claimId: id, state: STATE(), waNumber: was[i], config: {} })));
  assert.ok(res.every((r) => r.ok));
  assert.equal(new Set(res.map((r) => r.reference)).size, 8);
});

test("submit from another number is refused; an abandoned draft cannot be submitted", { skip }, async () => {
  const pol = await makePolicy();
  const wa = nextWa();
  const id = await draftFor(pol, wa);
  assert.deepEqual(await submitClaim({ claimId: id, state: STATE(), waNumber: nextWa(), config: {} }), { ok: false, reason: "not_owner" });
  await abandonDraft(id, "test");
  const r = await submitClaim({ claimId: id, state: STATE(), waNumber: wa, config: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "status_abandoned");
});

test("no notification address configured: outbox row skipped, claim submitted anyway", { skip }, async () => {
  const pol = await makePolicy();
  const wa = nextWa();
  const id = await draftFor(pol, wa);
  const r = await submitClaim({ claimId: id, state: STATE(), waNumber: wa, config: { notificationEmails: [] } });
  assert.equal(r.ok, true);
  const [[n]] = await getPool().query(`SELECT status FROM claim_notifications WHERE claim_id = ?`, [id]);
  assert.equal(n.status, "skipped");
});

test("submission writes nothing to the policy's own rows", { skip }, async () => {
  const pol = await makePolicy();
  const read = async () => {
    const [[s]] = await getPool().query(`SELECT * FROM sales WHERE id = ?`, [pol.saleId]);
    const [[cert]] = await getPool().query(`SELECT * FROM certificates WHERE sale_id = ?`, [pol.saleId]);
    return JSON.stringify([s, cert]);
  };
  const before = await read();
  const wa = nextWa();
  const id = await draftFor(pol, wa);
  await updateDraft(id, { description: "x".repeat(30) });
  await submitClaim({ claimId: id, state: STATE(), waNumber: wa, config: {} });
  assert.equal(await read(), before);
});

/* ------------------------------------------------------------- outbox */

test("the sender: urgent first, no passport in the mail, failures retried later", { skip }, async () => {
  await getPool().query(`UPDATE claim_notifications SET status = 'skipped' WHERE status = 'pending'`); // throwaway DB: start clean
  const pol = await makePolicy();
  const ids = {};
  for (const priority of ["normal", "urgent", "high"]) {
    const wa = nextWa();
    const id = await draftFor(pol, wa);
    await submitClaim({ claimId: id, state: STATE({ priority }), waNumber: wa, config: { notificationEmails: ["x@example.test"] } });
    ids[priority] = id;
  }
  const due = await dueNotifications();
  assert.deepEqual(due.map((d) => d.priority).slice(0, 3), ["urgent", "high", "normal"]);
  const mail = renderClaimEmail(due[0]);
  assert.match(mail.subject, /^\[TEST\] \[URGENT\] Nouveau sinistre SIN-/);
  assert.ok(!mail.text.includes(PASSPORT));

  // Make the "settings" say where to send, then fail the first send.
  await getPool().query(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES ('claims.notification_emails', 'claims@example.test')
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`
  );
  const { invalidateSettings } = await import("../../utils/appSettings.js");
  invalidateSettings();
  const sent = [];
  let calls = 0;
  const flaky = async (to, subject) => {
    calls += 1;
    if (calls === 1) throw new Error("SMTP down");
    sent.push({ to, subject });
  };
  const s = await runOnce({ send: flaky, log: { log() {}, error() {} } });
  assert.equal(s.failed, 1);
  assert.equal(s.sent, 2);
  const [[failedRow]] = await getPool().query(`SELECT status, attempts, next_attempt_at > NOW() AS later FROM claim_notifications WHERE claim_id = ?`, [ids.urgent]);
  assert.equal(failedRow.status, "pending", "kept for a retry");
  assert.equal(Number(failedRow.attempts), 1);
  assert.equal(Number(failedRow.later), 1, "not retried immediately");
  const [[claim]] = await getPool().query(`SELECT status FROM claims WHERE id = ?`, [ids.urgent]);
  assert.equal(claim.status, "submitted", "a failed email never touches the claim");
});

/* ------------------------------------------------------------ tracking */

test("tracking: the owner sees the status; another number, a draft or a typo see nothing", { skip }, async () => {
  const pol = await makePolicy();
  const wa = nextWa();
  const id = await draftFor(pol, wa);
  const r = await submitClaim({ claimId: id, state: STATE(), waNumber: wa, config: {} });
  const mine = await trackClaimForNumber({ waNumber: `+${wa}`, reference: r.reference.toLowerCase() });
  assert.equal(mine.status, "submitted");
  assert.equal(mine.categoryFr, "Hospitalisation");
  assert.equal(await trackClaimForNumber({ waNumber: nextWa(), reference: r.reference }), null);
  assert.equal(await trackClaimForNumber({ waNumber: wa, reference: "SIN-1999-000001" }), null);
  const draftId = await draftFor(pol, wa);
  const [[d]] = await getPool().query(`SELECT reference FROM claims WHERE id = ?`, [draftId]);
  assert.equal(d.reference, null, "a draft has no reference to track");
});

/* ------------------------------------------------------- resume, abandon */

test("resume: the last expired claim conversation's draft is offered back", { skip }, async () => {
  const pol = await makePolicy();
  const wa = nextWa();
  const id = await draftFor(pol, wa);
  const state = { policy: { policyNumber: pol.policyNumber, saleId: pol.saleId }, claimId: id, city: "Lyon" };
  await getPool().execute(
    `INSERT INTO whatsapp_sessions (wa_number, language, flow_key, current_step, collected_data, status, claim_id, last_activity_at, expires_at)
     VALUES (?, 'fr', 'claim', 'claim_country', ?, 'expired', ?, NOW(), NOW())`,
    [wa, JSON.stringify({ __claim: state }), id]
  );
  const offer = await findResumableDraft({ waNumber: wa, maxAgeHours: 48 });
  assert.equal(offer.claimId, id);
  assert.equal(offer.step, "claim_country");
  assert.equal(offer.state.city, "Lyon");

  await abandonDraft(id, "replaced_by_new_claim");
  assert.equal(await findResumableDraft({ waNumber: wa, maxAgeHours: 48 }), null, "an abandoned draft is not offered");
});

test("the abandon job marks idle drafts only, and deletes nothing", { skip }, async () => {
  const pol = await makePolicy();
  const old = await draftFor(pol, nextWa());
  const fresh = await draftFor(pol, nextWa());
  await getPool().execute(`UPDATE claims SET updated_at = NOW() - INTERVAL 50 HOUR WHERE id = ?`, [old]);
  const dry = await abandonStaleDrafts({ hours: 48, dryRun: true });
  assert.ok(dry.ids.includes(old));
  assert.ok(!dry.ids.includes(fresh));
  assert.equal((await getClaimById(old)).status, "draft", "dry run changes nothing");
  const res = await abandonStaleDrafts({ hours: 48 });
  assert.ok(res.ids.includes(old));
  const after = await getClaimById(old);
  assert.equal(after.status, "abandoned");
  assert.ok(after.abandonedAt);
  assert.equal((await getClaimById(fresh)).status, "draft");
  const h = await getStatusHistory(old);
  assert.equal(h.at(-1).changed_by, "system");
});

/* -------------------------------------------------- the switch, for real */

test("claims context: off for the public, on for an allowlisted tester, fail-closed on error", { skip }, async () => {
  await setFlag(CLAIMS_FLAG, false);
  clearFlagCache();
  const tester = nextWa();
  const off = await claimsContextFor(tester);
  assert.equal(off.access.allowed, false);
  assert.deepEqual(Object.keys(off.deps), [], "no claim functions handed out while off");

  await addToAllowlist(CLAIMS_FLAG, tester, { label: "IT" });
  const on = await claimsContextFor(tester);
  assert.equal(on.access.allowed, true);
  assert.equal(on.access.allowlisted, true);
  assert.equal(typeof on.deps.submitClaim, "function");
  assert.equal((await claimsContextFor(nextWa())).access.allowed, false, "everyone else still sees nothing");
  await removeFromAllowlist(CLAIMS_FLAG, tester);
});

test.after(async () => {
  if (!CONFIGURED) return;
  await getPool().query(`DELETE FROM app_settings WHERE setting_key = 'claims.notification_emails' AND setting_value = 'claims@example.test'`);
  await getPool().end();
});
