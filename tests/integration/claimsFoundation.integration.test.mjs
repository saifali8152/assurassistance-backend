// tests/integration/claimsFoundation.integration.test.mjs
//
// Milestone 4, Day 1 against a real database: the migrations, the claims
// switch, the allowlist, case numbering under concurrency and the draft →
// status lifecycle.
//
// What matters most here is the switch. Claims ship DORMANT to production, so
// "off means off" and "a broken flag table means off" are the two properties
// that let the code reach the live server safely.
//
// OPT-IN: set IT_DB_NAME to a throwaway database that has been migrated.
//
import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

import { initializePool, getPool } from "../../utils/db.js";
import {
  CLAIMS_FLAG, isFlagEnabled, flagAccess, getFlag, setFlag, clearFlagCache,
  addToAllowlist, removeFromAllowlist, listAllowlist, listFlagAudit,
} from "../../utils/featureFlags.js";
import {
  createDraft, updateDraft, transition, getClaimById, getStatusHistory, allocateClaimReference,
} from "../../models/claimModel.js";
import { getCategoryTree, getCategory, listAllCategories } from "../../models/claimCategoryModel.js";
import { getClaimsConfig } from "../../utils/appSettings.js";

const CONFIGURED = Boolean(process.env.IT_DB_NAME);
const skip = CONFIGURED ? false : "set IT_DB_NAME to run integration tests";

const DB = {
  DB_HOST: process.env.IT_DB_HOST || "127.0.0.1",
  DB_PORT: Number(process.env.IT_DB_PORT || 3306),
  DB_USER: process.env.IT_DB_USER || "root",
  DB_PASSWORD: process.env.IT_DB_PASSWORD || "",
  DB_NAME: process.env.IT_DB_NAME,
};
if (CONFIGURED) initializePool(DB);

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.join(here, "..", "..");
const RUN = Date.now().toString().slice(-8);
const WA = `22507${RUN}`;

const made = { external: [], claims: [] };

async function makeExternalPolicy() {
  const [r] = await getPool().execute(
    `INSERT INTO external_policies (policy_number, holder_first_name, holder_last_name, start_date, end_date, is_test, source)
     VALUES (?, 'IT', 'Claims', CURDATE(), DATE_ADD(CURDATE(), INTERVAL 30 DAY), 1, 'manual')`,
    [`IT-EXT-${RUN}-${Math.floor(Math.random() * 1e6)}`]
  );
  made.external.push(r.insertId);
  return r.insertId;
}

async function draft(extra = {}) {
  const id = await createDraft({ waNumber: WA, externalPolicyId: await makeExternalPolicy(), isTest: true, ...extra });
  made.claims.push(id);
  return id;
}

/* ---------------------------------------------------------------- schema */

test("migrations: every Milestone 4 table exists, and a re-run applies nothing", { skip }, async () => {
  const [rows] = await getPool().query(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()
       AND table_name IN ('feature_flags','feature_flag_allowlist','feature_flag_audit','claims','claim_documents',
                          'claim_status_history','claim_categories','external_policies','claim_validation_attempts',
                          'claim_notifications')`
  );
  assert.equal(rows.length, 10);
  const [cols] = await getPool().query(
    `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE()
       AND table_name = 'whatsapp_sessions' AND column_name IN ('claim_id','parked_purchase')`
  );
  assert.equal(cols.length, 2);

  const out = execFileSync(process.execPath, ["scripts/migrate.js"], {
    cwd: backend,
    env: { ...process.env, DB_HOST: DB.DB_HOST, DB_PORT: String(DB.DB_PORT), DB_USER: DB.DB_USER, DB_PASSWORD: DB.DB_PASSWORD, DB_NAME: DB.DB_NAME },
    encoding: "utf8",
  });
  assert.match(out, /up to date/i, out);
});

test("migrations: the seeded categories and settings are in place", { skip }, async () => {
  const all = await listAllCategories({ force: true });
  assert.equal(all.filter((c) => !c.parentCode).length >= 4, true);
  const tree = await getCategoryTree();
  assert.deepEqual(tree.slice(0, 4).map((c) => c.code), ["travel", "medical", "accident", "legal"]);
  assert.ok((await getCategory("flight_delay")).requiredDocuments.length >= 2);

  const cfg = await getClaimsConfig();
  assert.equal(cfg.numberFormat, "SIN-{YYYY}-{SEQ:6}");
  assert.equal(cfg.expiryRule, "incident_date");
  assert.equal(cfg.cardNumberMode, "certificate");
  assert.ok(cfg.urgentKeywords.fr.length > 0);
});

/* ---------------------------------------------------------------- switch */

test("switch: claims ship OFF", { skip }, async () => {
  clearFlagCache();
  const f = await getFlag(CLAIMS_FLAG);
  assert.ok(f, "the flag row is seeded");
  // Do not assume another test left it alone — force it off, then check.
  await setFlag(CLAIMS_FLAG, false);
  clearFlagCache();
  assert.equal(await isFlagEnabled(CLAIMS_FLAG), false);
  const a = await flagAccess(CLAIMS_FLAG, "+225 00 00 00 00 00");
  assert.deepEqual(a, { enabled: false, allowlisted: false, allowed: false });
});

test("switch: an unknown flag, or a database error, means OFF", { skip }, async () => {
  clearFlagCache();
  assert.equal(await isFlagEnabled("no_such_flag"), false);
  const broken = { query: async () => { throw new Error("connection lost"); } };
  clearFlagCache();
  assert.equal(await isFlagEnabled(CLAIMS_FLAG, { pool: broken }), false);
  clearFlagCache();
  const a = await flagAccess(CLAIMS_FLAG, WA, { pool: broken });
  assert.equal(a.allowed, false);
  clearFlagCache();
});

test("switch: turning it on and off is audited; repeating a state is not", { skip }, async () => {
  const before = (await listFlagAudit(CLAIMS_FLAG, { limit: 500 })).length;
  await setFlag(CLAIMS_FLAG, true, { ip: "127.0.0.1" });
  await setFlag(CLAIMS_FLAG, true, { ip: "127.0.0.1" }); // double click
  clearFlagCache(CLAIMS_FLAG);
  assert.equal(await isFlagEnabled(CLAIMS_FLAG), true);
  await setFlag(CLAIMS_FLAG, false);
  clearFlagCache(CLAIMS_FLAG);
  assert.equal(await isFlagEnabled(CLAIMS_FLAG), false);
  const audit = await listFlagAudit(CLAIMS_FLAG, { limit: 500 });
  assert.equal(audit.length - before, 2, "on + off; the repeat wrote nothing");
});

test("switch: the cache is what the caller sees until it is cleared", { skip }, async () => {
  clearFlagCache();
  assert.equal(await isFlagEnabled(CLAIMS_FLAG), false);
  await getPool().query(`UPDATE feature_flags SET enabled = 1 WHERE flag_key = ?`, [CLAIMS_FLAG]);
  assert.equal(await isFlagEnabled(CLAIMS_FLAG), false, "cached for up to 10 seconds");
  clearFlagCache(CLAIMS_FLAG);
  assert.equal(await isFlagEnabled(CLAIMS_FLAG), true);
  await getPool().query(`UPDATE feature_flags SET enabled = 0 WHERE flag_key = ?`, [CLAIMS_FLAG]);
  clearFlagCache();
});

/* ------------------------------------------------------------- allowlist */

test("allowlist: a listed number gets in while the switch is off, and is marked as a tester", { skip }, async () => {
  clearFlagCache();
  await addToAllowlist(CLAIMS_FLAG, `+${WA}`, { label: "IT tester" });
  await addToAllowlist(CLAIMS_FLAG, WA); // same number, different spelling: no duplicate
  const listed = (await listAllowlist(CLAIMS_FLAG)).filter((r) => String(r.wa_number || r.waNumber || "").includes(WA.slice(-4)) || r.label === "IT tester");
  assert.ok(listed.length >= 1);

  const a = await flagAccess(CLAIMS_FLAG, `+225 07 ${RUN}`);
  assert.deepEqual(a, { enabled: false, allowlisted: true, allowed: true });
  const other = await flagAccess(CLAIMS_FLAG, "2250799999999");
  assert.equal(other.allowed, false);

  await removeFromAllowlist(CLAIMS_FLAG, WA);
  // Removing clears the cache itself — no wait for the TTL.
  assert.equal((await flagAccess(CLAIMS_FLAG, WA)).allowed, false);

  const audit = await listFlagAudit(CLAIMS_FLAG, { limit: 50 });
  const mine = audit.filter((r) => ["allowlist_add", "allowlist_remove"].includes(r.action));
  assert.ok(mine.length >= 2);
  for (const r of mine) {
    assert.ok(!JSON.stringify(r).includes(WA), "audit never stores a full number");
  }
  assert.ok(mine.some((r) => JSON.stringify(r).includes(WA.slice(-4))), "but the last four digits identify it");
});

test("allowlist: a malformed number is refused", { skip }, async () => {
  assert.deepEqual(await addToAllowlist(CLAIMS_FLAG, "12345"), { ok: false, reason: "invalid_number" });
  assert.deepEqual(await addToAllowlist(CLAIMS_FLAG, "1".repeat(16)), { ok: false, reason: "invalid_number" });
  assert.deepEqual(await addToAllowlist("no_such_flag", WA), { ok: false, reason: "unknown_flag" });
});

/* ------------------------------------------------------------ numbering */

test("case numbers: twenty at once, twenty different numbers, in the configured format", { skip }, async () => {
  const pool = getPool();
  const refs = await Promise.all(
    Array.from({ length: 20 }, async () => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const r = await allocateClaimReference(conn, "SIN-{YYYY}-{SEQ:6}");
        await conn.commit();
        return r;
      } finally {
        conn.release();
      }
    })
  );
  assert.equal(new Set(refs).size, 20);
  const yyyy = String(new Date().getFullYear());
  for (const r of refs) assert.match(r, new RegExp(`^SIN-${yyyy}-\\d{6}$`));
});

/* ------------------------------------------------------------ lifecycle */

test("drafts: a claim needs a policy", { skip }, async () => {
  await assert.rejects(() => createDraft({ waNumber: WA }), /needs a policy/);
});

test("drafts: answers are written while it is a draft, and refused after", { skip }, async () => {
  const id = await draft();
  assert.equal(await updateDraft(id, { categoryCode: "travel", subcategoryCode: "flight_delay", extraFields: { flight_number: "AF702" } }), true);
  let c = await getClaimById(id);
  assert.equal(c.status, "draft");

  const t = await transition(id, "submitted", { by: "customer" });
  assert.equal(t.ok, true);
  assert.equal(await updateDraft(id, { description: "changed after submission" }), false, "a submitted claim is a record");
  c = await getClaimById(id);
  assert.notEqual(c.description, "changed after submission");
});

test("lifecycle: legal moves pass with history, illegal ones are refused and leave no trace", { skip }, async () => {
  const id = await draft();
  assert.equal((await transition(id, "closed")).ok, false, "a draft cannot be closed");
  assert.equal((await transition(id, "under_review")).ok, false);
  assert.equal((await transition(id, "submitted", { by: "customer" })).ok, true);
  assert.equal((await transition(id, "under_review", { by: "system", note: "picked up" })).ok, true);
  assert.equal((await transition(id, "submitted")).ok, false, "no going back");
  assert.equal((await transition(id, "closed", { note: "settled" })).ok, true);
  assert.equal((await transition(id, "under_review")).ok, false, "closed is final");

  const h = await getStatusHistory(id);
  assert.deepEqual(h.map((r) => r.to_status), ["draft", "submitted", "under_review", "closed"]);
  assert.equal(h[0].from_status, null);
  const c = await getClaimById(id);
  assert.ok(c.closedAt, "closing stamps the time");
  assert.ok(c.submittedAt, "submitting stamps the time");
});

test("lifecycle: abandoning a draft keeps the row and stamps the time", { skip }, async () => {
  const id = await draft();
  assert.equal((await transition(id, "abandoned", { by: "system" })).ok, true);
  const c = await getClaimById(id);
  assert.ok(c, "abandoned drafts are never deleted");
  assert.ok(c.abandonedAt);
  assert.equal((await transition(id, "submitted")).ok, false);
});

test("lifecycle: an unknown claim is reported, not thrown", { skip }, async () => {
  const r = await transition(999999999, "submitted");
  assert.deepEqual(r, { ok: false, reason: "not_found" });
});

/* -------------------------------------------------------------- cleanup */

test.after(async () => {
  if (!CONFIGURED) return;
  const pool = getPool();
  // Throwaway database: tidy our own rows so a re-run starts clean.
  if (made.claims.length) {
    await pool.query(`DELETE FROM claim_status_history WHERE claim_id IN (?)`, [made.claims]);
    await pool.query(`DELETE FROM claims WHERE id IN (?)`, [made.claims]);
  }
  if (made.external.length) await pool.query(`DELETE FROM external_policies WHERE id IN (?)`, [made.external]);
  await pool.query(`DELETE FROM feature_flag_allowlist WHERE wa_number = ?`, [WA]);
  await pool.query(`UPDATE feature_flags SET enabled = 0 WHERE flag_key = ?`, [CLAIMS_FLAG]);
  await pool.end();
});
