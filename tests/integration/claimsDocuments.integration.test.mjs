// tests/integration/claimsDocuments.integration.test.mjs
//
// Milestone 4, Day 5 against a real database and a real (temporary) storage
// folder: a document arrives, is checked, encrypted and recorded; failures
// are kept and re-fetched; redeliveries do not duplicate; limits hold.
//
// OPT-IN: set IT_DB_NAME to a throwaway database that has been migrated.
//
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

process.env.CLAIMS_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claimdocs-it-"));

const { initializePool, getPool } = await import("../../utils/db.js");
const { createDraft, transition } = await import("../../models/claimModel.js");
const { ingestDocument, refetchPendingDocuments, listDocuments, getDocument, countDocuments } = await import("../../models/claimDocumentModel.js");
const { readDecrypted, sha256Hex } = await import("../../utils/claims/documentStore.js");

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
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 9), Buffer.from([0xff, 0xd9])]);
const PDF = Buffer.from("%PDF-1.4\nhello\n%%EOF\n", "latin1");
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(300)]);
const CFG = { maxDocuments: 3, maxFileMb: 1 };

async function draft() {
  const [r] = await getPool().execute(
    `INSERT INTO external_policies (policy_number, start_date, end_date, is_test, source) VALUES (?, CURDATE(), CURDATE() + INTERVAL 10 DAY, 1, 'manual')`,
    [`DOC-${RUN}-${++seq}`]
  );
  return createDraft({ waNumber: `2251${RUN}${seq}`, externalPolicyId: r.insertId, isTest: true });
}

const wamid = () => `wamid.${RUN}.${++seq}`;

test("a good file is stored encrypted, with its facts recorded", { skip }, async () => {
  const claimId = await draft();
  const r = await ingestDocument({ claimId, waMessageId: wamid(), buffer: JPEG, declaredMime: "image/jpeg", filename: "billet.jpg", claimsConfig: CFG });
  assert.equal(r.ok, true);
  assert.equal(r.status, "stored");
  assert.equal(r.count, 1);
  const row = await getDocument(r.documentId);
  assert.equal(row.status, "stored");
  assert.equal(row.detected_mime, "image/jpeg");
  assert.equal(row.original_filename, "billet.jpg");
  assert.equal(row.sha256, sha256Hex(JPEG));
  assert.equal(Number(row.size_bytes), JPEG.length);
  assert.match(row.storage_key, /^\d{4}\/\d{2}\/[0-9a-f]{32}\.bin$/);
  assert.ok(!row.storage_key.includes("billet"), "the name on disk says nothing");
  assert.ok(readDecrypted(row.storage_key).equals(JPEG));
});

test("a program renamed .pdf is rejected and the attempt is kept, not the file", { skip }, async () => {
  const claimId = await draft();
  const r = await ingestDocument({ claimId, waMessageId: wamid(), buffer: EXE, declaredMime: "application/pdf", filename: "facture.pdf", claimsConfig: CFG });
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: "bad_type" });
  const row = await getDocument(r.documentId);
  assert.equal(row.status, "rejected");
  assert.equal(row.failure_code, "bad_type");
  assert.equal(row.storage_key, null, "nothing written to disk");
  assert.equal(await countDocuments(claimId), 0, "rejected files do not count");
});

test("too large is refused with its own reason", { skip }, async () => {
  const claimId = await draft();
  const big = Buffer.concat([PDF.subarray(0, 9), Buffer.alloc(1.5 * 1024 * 1024), Buffer.from("%%EOF")]);
  const r = await ingestDocument({ claimId, waMessageId: wamid(), buffer: big, claimsConfig: CFG });
  assert.equal(r.code, "too_large");
});

test("the count limit holds", { skip }, async () => {
  const claimId = await draft();
  for (let i = 0; i < 3; i += 1) assert.equal((await ingestDocument({ claimId, waMessageId: wamid(), buffer: PDF, claimsConfig: CFG })).ok, true);
  const r = await ingestDocument({ claimId, waMessageId: wamid(), buffer: PDF, claimsConfig: CFG });
  assert.deepEqual(r, { ok: false, code: "too_many", max: 3 });
});

test("a webhook delivered twice attaches the file once", { skip }, async () => {
  const claimId = await draft();
  const id = wamid();
  const a = await ingestDocument({ claimId, waMessageId: id, buffer: PDF, claimsConfig: CFG });
  const b = await ingestDocument({ claimId, waMessageId: id, buffer: PDF, claimsConfig: CFG });
  assert.equal(b.duplicate, true);
  assert.equal(b.documentId, a.documentId);
  assert.equal((await listDocuments(claimId)).length, 1);
});

test("files are only taken while the claim is a draft", { skip }, async () => {
  const claimId = await draft();
  await transition(claimId, "abandoned", { by: "system" });
  assert.deepEqual(await ingestDocument({ claimId, waMessageId: wamid(), buffer: PDF, claimsConfig: CFG }), { ok: false, code: "not_draft" });
});

test("Meta down: the document is kept pending with its media id, and the job fetches it later", { skip }, async () => {
  const claimId = await draft();
  let metaUp = false;
  const fetchImpl = async (url) => {
    if (!metaUp) throw new Error("ECONNREFUSED");
    if (url.includes("graph.facebook.com")) return { ok: true, status: 200, json: async () => ({ url: "https://cdn.example/f", file_size: PDF.length, mime_type: "application/pdf" }) };
    return { ok: true, status: 200, arrayBuffer: async () => PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.length) };
  };
  const waConfig = { accessToken: "t", apiVersion: "v21.0" };
  const r = await ingestDocument({ claimId, waMessageId: wamid(), mediaId: `MEDIA${RUN}`, filename: "rapport.pdf", waConfig, claimsConfig: CFG, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.status, "pending");
  let row = await getDocument(r.documentId);
  assert.equal(row.status, "pending");
  assert.equal(row.media_id, `MEDIA${RUN}`);
  assert.equal(Number(row.attempts), 1);

  // Due now (the test does not wait five minutes).
  await getPool().execute(`UPDATE claim_documents SET next_attempt_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?`, [r.documentId]);
  metaUp = true;
  const job = await refetchPendingDocuments({ waConfig, claimsConfig: CFG, fetchImpl });
  assert.ok(job.stored >= 1);
  row = await getDocument(r.documentId);
  assert.equal(row.status, "stored");
  assert.ok(readDecrypted(row.storage_key).equals(PDF));
});

test("the re-fetch job gives up after six tries and marks it failed, never deletes", { skip }, async () => {
  const claimId = await draft();
  const fetchImpl = async () => { throw new Error("ETIMEDOUT"); };
  const waConfig = { accessToken: "t" };
  const r = await ingestDocument({ claimId, waMessageId: wamid(), mediaId: "GONE", waConfig, claimsConfig: CFG, fetchImpl });
  for (let i = 0; i < 6; i += 1) {
    await getPool().execute(`UPDATE claim_documents SET next_attempt_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?`, [r.documentId]);
    await refetchPendingDocuments({ waConfig, claimsConfig: CFG, fetchImpl });
  }
  const row = await getDocument(r.documentId);
  assert.equal(row.status, "failed");
  assert.equal(Number(row.attempts), 6);
});

test.after(async () => {
  fs.rmSync(process.env.CLAIMS_STORAGE_DIR, { recursive: true, force: true });
  if (CONFIGURED) await getPool().end();
});

test("retention: off by default; when set, only files of old closed/abandoned claims go, rows stay", { skip }, async () => {
  const { purgeExpiredDocuments } = await import("../../models/claimDocumentModel.js");
  assert.deepEqual(await purgeExpiredDocuments({ retentionDays: null }), { enabled: false, due: 0, purged: 0 });

  const oldClaim = await draft();
  const live = await draft();
  const a = await ingestDocument({ claimId: oldClaim, waMessageId: wamid(), buffer: PDF, claimsConfig: CFG });
  const b = await ingestDocument({ claimId: live, waMessageId: wamid(), buffer: PDF, claimsConfig: CFG });
  await transition(oldClaim, "abandoned", { by: "system" });
  await getPool().execute(`UPDATE claims SET abandoned_at = NOW() - INTERVAL 400 DAY WHERE id = ?`, [oldClaim]);

  const dry = await purgeExpiredDocuments({ retentionDays: 365, dryRun: true });
  assert.ok(dry.ids.includes(a.documentId));
  assert.ok(!dry.ids.includes(b.documentId), "a draft's files are never purged");
  const keyA = (await getDocument(a.documentId)).storage_key;
  assert.ok(readDecrypted(keyA).equals(PDF), "dry run removed nothing");

  await purgeExpiredDocuments({ retentionDays: 365 });
  const rowA = await getDocument(a.documentId);
  assert.equal(rowA.status, "purged");
  assert.ok(rowA.purged_at);
  assert.throws(() => readDecrypted(keyA), "the file is gone");
  assert.equal((await getDocument(b.documentId)).status, "stored");
  const [[c]] = await getPool().query(`SELECT COUNT(*) AS n FROM claims WHERE id = ?`, [oldClaim]);
  assert.equal(Number(c.n), 1, "the claim row stays");
});
