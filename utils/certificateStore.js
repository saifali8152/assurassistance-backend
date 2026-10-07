// src/utils/certificateStore.js
//
// Where an issued certificate PDF lives on disk.
//
// WHY STORE IT AT ALL
// The payload a certificate is drawn from is assembled from LIVE data — the
// plan, its guarantees, its partner logo, its theme colour. Milestone 3 froze
// the FIGURES in certificates.issued_snapshot, so re-rendering can no longer
// print a different premium than the customer's copy. It did not freeze the
// bytes: a logo swap or a layout change still alters the document a travelling
// customer may be asked to show at a border. Writing the rendered file once and
// serving that file afterwards closes the gap, and it is what
// certificates.pdf_path was always for (it had no writer until now).
//
// WHAT IS AND IS NOT CACHED
// Only certificates that carry an issued_snapshot. Those are frozen by design,
// so storing them changes nothing except that the bytes stop moving. A legacy
// certificate with no snapshot keeps rendering live, exactly as before, because
// caching one would silently freeze a document whose figures are still meant to
// follow the catalogue — a behaviour change nobody asked for.
//
// NOT UNDER uploads/
// `uploads/` is served by express.static, and a certificate number is sequential:
// CERT-2026-000042 tells you that CERT-2026-000041 exists. A stored certificate
// under that tree would therefore be downloadable by anyone willing to count, and
// a certificate carries the traveller's passport number. So these files live in
// `storage/`, which nothing serves, and the only public route to a certificate
// stays the one gated by its 48-character token.
//
// ONE FILE PER LANGUAGE
// The same certificate exists in French and English and they are different
// documents. The file name carries the language; pdf_path records the first
// rendition written, so the column keeps pointing at a real file and does not
// flip between languages on every download.
//
// Deleting a file here is always safe: the next request re-renders and re-stores
// it. That is the supported way to pick up a layout or logo change (see
// docs/RUNBOOK.md).
//
import fs from "fs";
import path from "path";
import { updateCertificatePdf } from "../models/certificateModel.js";

/**
 * Meta's hard limit for a document message. Our certificates are around 100 KB,
 * so this guard exists for the case we cannot foresee — a plan with a very large
 * partner logo, a future multi-page attestation — not for today's files. The
 * point is that an oversized document degrades to a link instead of a silent
 * rejection by Meta, which the customer would experience as nothing arriving.
 */
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

export const CERTIFICATE_DIR_NAME = path.join("storage", "certificates");

export function certificateDir() {
  return path.join(process.cwd(), CERTIFICATE_DIR_NAME);
}

export function normaliseLocale(locale) {
  return String(locale || "").toLowerCase().startsWith("fr") ? "fr" : "en";
}

/** A certificate number is operator-visible; never let it escape the directory. */
export function safeSlug(certificateNumber) {
  const slug = String(certificateNumber || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 120);
  return slug || null;
}

export function certificateFileName(certificateNumber, locale) {
  const slug = safeSlug(certificateNumber);
  if (!slug) return null;
  return `${slug}-${normaliseLocale(locale)}.pdf`;
}

/**
 * What goes in certificates.pdf_path.
 *
 * A filesystem path relative to the backend's working directory — NOT a URL, and
 * deliberately without a leading slash so it cannot be mistaken for one. There is
 * no public URL for these files; see the note at the top of this file.
 */
export function relativePathFor(fileName) {
  return fileName ? `${CERTIFICATE_DIR_NAME.split(path.sep).join("/")}/${fileName}` : null;
}

export function absolutePathFor(fileName) {
  return fileName ? path.join(certificateDir(), fileName) : null;
}

/** True when this certificate is frozen and therefore safe to store. */
export function isStorable(cert) {
  if (!cert) return false;
  if (!safeSlug(cert.certificate_number)) return false;
  return Boolean(cert.issued_snapshot);
}

/**
 * The stored rendition, or null. Never throws: a missing, unreadable or empty
 * file simply means "re-render", which is always correct.
 */
export function readStoredCertificate(certificateNumber, locale) {
  const fileName = certificateFileName(certificateNumber, locale);
  const fsPath = absolutePathFor(fileName);
  if (!fsPath) return null;
  try {
    const stat = fs.statSync(fsPath);
    if (!stat.isFile() || stat.size === 0) return null;
    const buffer = fs.readFileSync(fsPath);
    if (!buffer?.length) return null;
    return { buffer, bytes: stat.size, fileName, relativePath: relativePathFor(fileName), fsPath };
  } catch {
    return null;
  }
}

/** Size of the stored rendition without reading it, or null. */
export function statStoredCertificate(certificateNumber, locale) {
  const fileName = certificateFileName(certificateNumber, locale);
  const fsPath = absolutePathFor(fileName);
  if (!fsPath) return null;
  try {
    const stat = fs.statSync(fsPath);
    if (!stat.isFile() || stat.size === 0) return null;
    return { bytes: stat.size, fileName, relativePath: relativePathFor(fileName), fsPath };
  } catch {
    return null;
  }
}

/**
 * Write a rendition and record it.
 *
 * Written to a temporary name and renamed into place, because two downloads of
 * the same certificate can land at the same moment and a half-written PDF read
 * by the other one is worse than no cache at all. rename() within a directory is
 * atomic on every filesystem we deploy on.
 *
 * A failure here is never fatal — the caller already holds the buffer it needs.
 */
export async function storeCertificatePdf({ certificateId, certificateNumber, locale, buffer, recordPath = true }) {
  const fileName = certificateFileName(certificateNumber, locale);
  if (!fileName || !buffer?.length) return null;
  const dir = certificateDir();
  const fsPath = path.join(dir, fileName);
  const tmpPath = path.join(dir, `.${fileName}.${process.pid}.${Date.now()}.tmp`);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, fsPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    return { ok: false, error: err?.message || String(err) };
  }

  const relativePath = relativePathFor(fileName);
  if (recordPath && certificateId) {
    // First rendition wins the column, so pdf_path stays stable instead of
    // flipping language every time somebody downloads the other one.
    try {
      await updateCertificatePdfIfEmpty(certificateId, relativePath);
    } catch { /* the file is written; the column is a convenience */ }
  }
  return { ok: true, fileName, relativePath, fsPath, bytes: buffer.length };
}

async function updateCertificatePdfIfEmpty(certificateId, relativePath) {
  const { default: getPool } = await import("./db.js");
  const [rows] = await getPool().query(`SELECT pdf_path FROM certificates WHERE id = ? LIMIT 1`, [certificateId]);
  const existing = rows[0]?.pdf_path;
  if (existing && String(existing).trim() !== "") {
    // Already recorded — but if the recorded file has since been deleted, point
    // the column at something that exists.
    const current = String(existing).trim();
    // Only a relative path is ours to resolve; anything else was written by hand.
    const abs = path.isAbsolute(current) ? null : path.join(process.cwd(), current);
    if (abs && fs.existsSync(abs)) return;
  }
  await updateCertificatePdf(certificateId, relativePath);
}

export const __testables = { updateCertificatePdfIfEmpty };
