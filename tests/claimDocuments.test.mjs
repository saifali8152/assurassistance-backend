// tests/claimDocuments.test.mjs
//
// Milestone 4, Day 5 — the document rules, with no database: type by first
// bytes, size, truncation, hash, encryption round trip, the storage key guard,
// the Meta download with retries, and the parser leaving the purchase answer
// untouched.
//
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.CLAIMS_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claimdocs-"));

const {
  sniffType, looksTruncated, hashMatches, inspectDocument, encryptBuffer, decryptBuffer,
  writeEncrypted, readDecrypted, downloadMetaMedia, scanDocument, sha256Hex,
} = await import("../utils/claims/documentStore.js");
const { parseWebhookPayload } = await import("../utils/whatsapp/parser.js");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1), Buffer.from("IEND", "latin1"), Buffer.alloc(4)]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n", "latin1");
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(300, 0)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 0)]);

test("type is decided by the first bytes, not the name", () => {
  assert.equal(sniffType(JPEG), "image/jpeg");
  assert.equal(sniffType(PNG), "image/png");
  assert.equal(sniffType(PDF), "application/pdf");
  assert.equal(sniffType(EXE), null, "a Windows program");
  assert.equal(sniffType(ZIP), null, "an archive (and every .docx/.xlsx, which are zips)");
  assert.equal(sniffType(Buffer.from("<html><script>alert(1)</script>")), null);
  assert.equal(sniffType(Buffer.alloc(3)), null);
});

test("a file cut short in transit is recognised as damaged", () => {
  assert.equal(looksTruncated(JPEG, "image/jpeg"), false);
  assert.equal(looksTruncated(JPEG.subarray(0, 100), "image/jpeg"), true);
  assert.equal(looksTruncated(PDF, "application/pdf"), false);
  assert.equal(looksTruncated(PDF.subarray(0, 20), "application/pdf"), true);
  assert.equal(looksTruncated(PNG, "image/png"), false);
});

test("Meta's hash is checked whether it comes as hex or base64", () => {
  const hex = sha256Hex(PDF);
  const b64 = Buffer.from(hex, "hex").toString("base64");
  assert.equal(hashMatches(PDF, hex), true);
  assert.equal(hashMatches(PDF, b64), true);
  assert.equal(hashMatches(PDF, null), true, "nothing declared, nothing to compare");
  assert.equal(hashMatches(JPEG, hex), false);
});

test("inspection: every rejection has its own reason", async () => {
  assert.deepEqual(await inspectDocument(Buffer.alloc(0)), { ok: false, code: "empty" });
  assert.equal((await inspectDocument(JPEG, { maxBytes: 100 })).code, "too_large");
  assert.equal((await inspectDocument(EXE)).code, "bad_type");
  assert.equal((await inspectDocument(JPEG.subarray(0, 50))).code, "corrupted");
  assert.equal((await inspectDocument(JPEG, { declaredSha256: sha256Hex(PDF) })).code, "hash_mismatch");
  const ok = await inspectDocument(PDF, { maxBytes: 10 * 1024 * 1024 });
  assert.equal(ok.ok, true);
  assert.equal(ok.type, "application/pdf");
  assert.equal(ok.sha256, sha256Hex(PDF));
});

test("the scan hook is a documented no-op that accepts", async () => {
  assert.deepEqual(await scanDocument(PDF), { ok: true, scanned: false });
});

test("encryption: round trip, fresh IV each time, and tampering is refused", () => {
  const a = encryptBuffer(PDF);
  const b = encryptBuffer(PDF);
  assert.ok(!a.equals(b), "same file, different ciphertext");
  assert.ok(!a.includes(Buffer.from("%PDF")), "nothing readable on disk");
  assert.ok(decryptBuffer(a).equals(PDF));
  const tampered = Buffer.from(a);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => decryptBuffer(tampered));
});

test("storage: random names under storage/claims, readable only through the key format", () => {
  const key = writeEncrypted(JPEG, { now: new Date(2026, 10, 13) });
  assert.match(key, /^2026\/11\/[0-9a-f]{32}\.bin$/);
  const onDisk = fs.readFileSync(path.join(process.env.CLAIMS_STORAGE_DIR, key));
  assert.ok(!onDisk.subarray(0, 8).equals(JPEG.subarray(0, 8)), "stored encrypted");
  assert.ok(readDecrypted(key).equals(JPEG));
  assert.throws(() => readDecrypted("../../../etc/passwd"), /invalid storage key/);
  assert.throws(() => readDecrypted("2026/11/../../x.bin"), /invalid storage key/);
});

/* ------------------------------------------------------- Meta download */

function fakeFetch(script) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, auth: opts?.headers?.Authorization });
    const step = script[calls.length - 1] || script[script.length - 1];
    if (step.throw) throw new Error(step.throw);
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async () => step.json,
      arrayBuffer: async () => step.body.buffer.slice(step.body.byteOffset, step.body.byteOffset + step.body.length),
    };
  };
  fn.calls = calls;
  return fn;
}

const CFG = { accessToken: "tok", apiVersion: "v21.0" };

test("download: lookup then fetch, both with the token", async () => {
  const f = fakeFetch([
    { status: 200, json: { url: "https://lookaside.example/x", mime_type: "application/pdf", sha256: sha256Hex(PDF), file_size: PDF.length } },
    { status: 200, body: PDF },
  ]);
  const r = await downloadMetaMedia("MEDIA1", { config: CFG, fetchImpl: f, backoffMs: [1] });
  assert.equal(r.ok, true);
  assert.ok(r.buffer.equals(PDF));
  assert.match(f.calls[0].url, /graph\.facebook\.com\/v21\.0\/MEDIA1$/);
  assert.equal(f.calls[1].auth, "Bearer tok");
});

test("download: an oversized file is refused from its metadata, never pulled in", async () => {
  const f = fakeFetch([{ status: 200, json: { url: "u", file_size: 50 * 1024 * 1024 } }]);
  const r = await downloadMetaMedia("M", { config: CFG, maxBytes: 10 * 1024 * 1024, fetchImpl: f });
  assert.deepEqual(r, { ok: false, code: "too_large", retryable: false });
  assert.equal(f.calls.length, 1);
});

test("download: network trouble and 5xx are retried, then reported as retryable", async () => {
  const f = fakeFetch([{ throw: "ECONNRESET" }, { status: 503, json: {} }, { throw: "ETIMEDOUT" }]);
  const r = await downloadMetaMedia("M", { config: CFG, fetchImpl: f, backoffMs: [1, 1, 1] });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
  assert.equal(f.calls.length, 3);
});

test("download: a recovered second attempt succeeds", async () => {
  const f = fakeFetch([
    { throw: "ECONNRESET" },
    { status: 200, json: { url: "u", file_size: JPEG.length } },
    { status: 200, body: JPEG },
  ]);
  const r = await downloadMetaMedia("M", { config: CFG, fetchImpl: f, backoffMs: [1, 1] });
  assert.equal(r.ok, true);
});

test("download: expired media is not retried", async () => {
  const f = fakeFetch([{ status: 404, json: {} }]);
  assert.deepEqual(await downloadMetaMedia("M", { config: CFG, fetchImpl: f }), { ok: false, code: "media_gone", retryable: false });
});

test("download: without WhatsApp credentials it waits for them rather than failing for good", async () => {
  assert.deepEqual(await downloadMetaMedia("M", { config: {} }), { ok: false, code: "not_configured", retryable: true });
});

/* -------------------------------------------------------------- parser */

const payload = (msg) => ({ entry: [{ changes: [{ value: { metadata: {}, contacts: [], messages: [{ from: "225", id: "wamid.1", timestamp: "1", ...msg }] } }] }] });

test("parser: a photo is still 'unsupported' for the purchase flow, with what a claim needs", () => {
  const m = parseWebhookPayload(payload({ type: "image", image: { id: "IMG1", mime_type: "image/jpeg", sha256: "abc", caption: " billet " } })).messages[0];
  assert.equal(m.type, "unsupported");
  assert.equal(m.unsupportedKind, "image");
  assert.deepEqual(m.media, { kind: "image", id: "IMG1", mimeType: "image/jpeg", sha256: "abc", filename: null, caption: "billet" });
});

test("parser: a PDF carries its file name", () => {
  const m = parseWebhookPayload(payload({ type: "document", document: { id: "DOC1", mime_type: "application/pdf", filename: "rapport.pdf" } })).messages[0];
  assert.equal(m.media.filename, "rapport.pdf");
  assert.equal(m.unsupportedKind, "document");
});

test("parser: video, voice and stickers are unchanged and carry no media", () => {
  for (const type of ["video", "audio", "voice", "sticker"]) {
    const m = parseWebhookPayload(payload({ type, [type]: { id: "X" } })).messages[0];
    assert.equal(m.type, "unsupported");
    assert.equal(m.media, undefined, type);
  }
});

test.after(() => {
  fs.rmSync(process.env.CLAIMS_STORAGE_DIR, { recursive: true, force: true });
});

