// utils/claims/documentStore.js
//
// Milestone 4, Day 5 — claim documents: fetched from Meta, checked, encrypted,
// stored on our own server (D2).
//
// WHERE: storage/claims/<yyyy>/<mm>/<32 random hex>.bin, beside
// storage/certificates — never under uploads/, which is web-served. Nothing in
// the file name says whose it is or what it contains; the original name is
// kept only as metadata in claim_documents.
//
// HOW: AES-256-GCM with a key derived from SETTINGS_ENCRYPTION_KEY (the same
// master key as the settings and passports, separated by purpose), a fresh IV
// per file, and the authentication tag checked on every read — a file altered
// on disk refuses to decrypt rather than serving something else.
//
// WHAT IS ACCEPTED: JPEG, PNG and PDF only, decided by the file's first bytes,
// not by its name or by what the sender's phone declared. That alone blocks
// executables, archives, scripts and Office files with macros (D8).
//
// SCANNING: scanDocument() is the hook a virus scanner would sit in. With no
// scanner installed (D8: no ClamAV), it is a documented no-op that accepts —
// the type allowlist above is the protection.
//
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getMasterKey } from "../appCrypto.js";

export const ALLOWED_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};

const MAGIC = 0x41414431; // "AAD1" — file format version
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function claimsStorageRoot() {
  return path.resolve(process.env.CLAIMS_STORAGE_DIR || path.join(process.cwd(), "storage", "claims"));
}

/** What a file really is, from its first bytes. null for anything else. */
export function sniffType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

/** A file whose type is right but whose body is cut short (a failed upload). */
export function looksTruncated(buffer, type) {
  if (type === "image/jpeg") {
    // A complete JPEG ends with the EOI marker, possibly followed by padding.
    const tail = buffer.subarray(Math.max(0, buffer.length - 64));
    return tail.indexOf(Buffer.from([0xff, 0xd9])) === -1;
  }
  if (type === "image/png") {
    return buffer.subarray(Math.max(0, buffer.length - 12)).indexOf(Buffer.from("IEND", "latin1")) === -1;
  }
  if (type === "application/pdf") {
    return buffer.subarray(Math.max(0, buffer.length - 1024)).toString("latin1").indexOf("%%EOF") === -1;
  }
  return false;
}

export function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** Meta's hash may be hex or base64; compare either way. Absent → nothing to compare. */
export function hashMatches(buffer, declared) {
  if (!declared) return true;
  const hex = sha256Hex(buffer);
  const d = String(declared).trim();
  if (/^[0-9a-f]{64}$/i.test(d)) return d.toLowerCase() === hex;
  try {
    return Buffer.from(d, "base64").toString("hex") === hex;
  } catch {
    return false;
  }
}

/**
 * The scan hook (D8). Returns { ok: true } today. A scanner, if one is ever
 * installed, goes here and returns { ok: false, code: "infected" } to reject.
 */
export async function scanDocument(_buffer, _meta = {}) {
  return { ok: true, scanned: false };
}

function documentKey() {
  return crypto.createHash("sha256").update(Buffer.concat([Buffer.from("claim-documents:v1:"), getMasterKey()])).digest();
}

export function encryptBuffer(plain) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", documentKey(), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAGIC, 0);
  return Buffer.concat([header, iv, cipher.getAuthTag(), body]);
}

export function decryptBuffer(stored) {
  if (!Buffer.isBuffer(stored) || stored.length < 4 + IV_BYTES + TAG_BYTES) throw new Error("not a claim document");
  if (stored.readUInt32BE(0) !== MAGIC) throw new Error("unknown claim document format");
  const iv = stored.subarray(4, 4 + IV_BYTES);
  const tag = stored.subarray(4 + IV_BYTES, 4 + IV_BYTES + TAG_BYTES);
  const body = stored.subarray(4 + IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", documentKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/**
 * Check a downloaded file against every rule. Pure: no disk, no database.
 * @returns { ok:true, type, size, sha256 } | { ok:false, code }
 *   codes: empty · too_large · bad_type · corrupted · hash_mismatch · infected
 */
export async function inspectDocument(buffer, { maxBytes, declaredSha256 = null } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, code: "empty" };
  if (maxBytes && buffer.length > maxBytes) return { ok: false, code: "too_large" };
  const type = sniffType(buffer);
  if (!type) return { ok: false, code: "bad_type" };
  if (!hashMatches(buffer, declaredSha256)) return { ok: false, code: "hash_mismatch" };
  if (looksTruncated(buffer, type)) return { ok: false, code: "corrupted" };
  const scan = await scanDocument(buffer, { type });
  if (!scan.ok) return { ok: false, code: scan.code || "infected" };
  return { ok: true, type, size: buffer.length, sha256: sha256Hex(buffer) };
}

/** Encrypt and write. Returns the storage key (a relative path). */
export function writeEncrypted(buffer, { now = new Date() } = {}) {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const name = `${crypto.randomBytes(16).toString("hex")}.bin`;
  const rel = `${yyyy}/${mm}/${name}`;
  const dir = path.join(claimsStorageRoot(), yyyy, mm);
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const full = path.join(dir, name);
  const tmp = `${full}.tmp`;
  fs.writeFileSync(tmp, encryptBuffer(buffer), { mode: 0o640 });
  fs.renameSync(tmp, full); // never a half-written file under the real name
  return rel;
}

/** Read and decrypt by storage key. Refuses keys that leave the storage root. */
export function readDecrypted(storageKey) {
  if (!/^\d{4}\/\d{2}\/[0-9a-f]{32}\.bin$/.test(String(storageKey || ""))) throw new Error("invalid storage key");
  const full = path.join(claimsStorageRoot(), storageKey);
  return decryptBuffer(fs.readFileSync(full));
}

/* ------------------------------------------------------- fetching from Meta */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Two calls, as the Graph API requires: the media id → a short-lived URL and
 * metadata; then the URL → the bytes (it needs the token too). Retried with
 * backoff on network errors and 5xx/429. Size is checked from the metadata
 * BEFORE downloading, so an oversized file is never pulled in.
 *
 * @returns { ok:true, buffer, mimeType, sha256, fileSize } | { ok:false, code, retryable }
 */
export async function downloadMetaMedia(mediaId, { config, maxBytes, fetchImpl = globalThis.fetch, attempts = 3, backoffMs = [500, 1500, 4000] } = {}) {
  if (!mediaId) return { ok: false, code: "no_media_id", retryable: false };
  if (!config?.accessToken) return { ok: false, code: "not_configured", retryable: true };
  const auth = { Authorization: `Bearer ${config.accessToken}` };
  let lastCode = "download_failed";
  for (let i = 0; i < attempts; i += 1) {
    try {
      const metaRes = await fetchImpl(`https://graph.facebook.com/${config.apiVersion || "v21.0"}/${encodeURIComponent(mediaId)}`, { headers: auth });
      if (metaRes.status === 404) return { ok: false, code: "media_gone", retryable: false };
      if (!metaRes.ok) throw Object.assign(new Error(`media lookup ${metaRes.status}`), { status: metaRes.status });
      const meta = await metaRes.json();
      if (maxBytes && Number(meta.file_size) > maxBytes) return { ok: false, code: "too_large", retryable: false };
      const fileRes = await fetchImpl(meta.url, { headers: auth });
      if (!fileRes.ok) throw Object.assign(new Error(`media download ${fileRes.status}`), { status: fileRes.status });
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      return { ok: true, buffer, mimeType: meta.mime_type || null, sha256: meta.sha256 || null, fileSize: Number(meta.file_size) || buffer.length };
    } catch (err) {
      const status = Number(err?.status || 0);
      if (status && status < 500 && status !== 429) return { ok: false, code: `http_${status}`, retryable: false };
      lastCode = status ? `http_${status}` : "network";
      if (i < attempts - 1) await sleep(backoffMs[Math.min(i, backoffMs.length - 1)]);
    }
  }
  return { ok: false, code: lastCode, retryable: true };
}

/** Remove one stored file (retention only). Missing already is fine. */
export function removeStored(storageKey) {
  if (!/^\d{4}\/\d{2}\/[0-9a-f]{32}\.bin$/.test(String(storageKey || ""))) throw new Error("invalid storage key");
  try {
    fs.unlinkSync(path.join(claimsStorageRoot(), storageKey));
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}
