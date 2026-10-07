// tests/certificateStore.test.mjs
//
// Where a certificate PDF is written, and the two things that must not go
// wrong there: a certificate number that escapes the directory, and a partly
// written file being served to the next reader.
//
// No database and no HTTP — the store is deliberately a file-system module, so
// these tests exercise it against a real temporary directory.
//
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  MAX_DOCUMENT_BYTES,
  certificateDir,
  certificateFileName,
  isStorable,
  normaliseLocale,
  readStoredCertificate,
  relativePathFor,
  safeSlug,
  statStoredCertificate,
  storeCertificatePdf,
} from "../utils/certificateStore.js";

/** Each test gets its own cwd so nothing lands in the real uploads folder. */
async function inTempCwd(fn) {
  const before = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "certstore-"));
  try {
    process.chdir(dir);
    // Awaited, not returned: a `finally` that fires while the body is still
    // running would delete the directory under the test.
    return await fn(dir);
  } finally {
    process.chdir(before);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------- naming */

test("the file name carries the language, because the two documents differ", () => {
  assert.equal(certificateFileName("AA-CERT-2026-000042", "fr"), "AA-CERT-2026-000042-fr.pdf");
  assert.equal(certificateFileName("AA-CERT-2026-000042", "en"), "AA-CERT-2026-000042-en.pdf");
  assert.notEqual(
    certificateFileName("AA-CERT-2026-000042", "fr"),
    certificateFileName("AA-CERT-2026-000042", "en")
  );
});

test("an unknown or missing language reads as English rather than throwing", () => {
  assert.equal(normaliseLocale(null), "en");
  assert.equal(normaliseLocale("de"), "en");
  assert.equal(normaliseLocale("FR-fr"), "fr");
  assert.equal(normaliseLocale("fr"), "fr");
});

test("a certificate number cannot escape the certificates directory", () => {
  // The number comes from a format an administrator edits, so it is not a
  // constant we control.
  for (const hostile of ["../../etc/passwd", "..\\..\\windows", "/etc/shadow", "a/b/c"]) {
    const name = certificateFileName(hostile, "fr");
    assert.ok(name, `${hostile} should still produce a name`);
    assert.ok(!name.includes("/"), `${hostile} -> ${name} must not contain a separator`);
    assert.ok(!name.includes("\\"), `${hostile} -> ${name} must not contain a separator`);
    assert.ok(!name.startsWith("."), `${hostile} -> ${name} must not be a dotfile`);
    const resolved = path.resolve(certificateDir(), name);
    assert.ok(
      resolved.startsWith(path.resolve(certificateDir()) + path.sep),
      `${hostile} -> ${resolved} escaped the directory`
    );
  }
});

test("an empty certificate number produces no name at all", () => {
  assert.equal(safeSlug("   "), null);
  assert.equal(safeSlug("..."), null);
  assert.equal(certificateFileName("", "fr"), null);
  assert.equal(relativePathFor(null), null);
});

test("the stored path is a relative filesystem path, not a URL", () => {
  // No leading slash, and not under uploads/: these files are not served.
  assert.equal(relativePathFor("AA-1-fr.pdf"), "storage/certificates/AA-1-fr.pdf");
});

test("nothing is stored anywhere express.static serves", () => {
  assert.ok(!relativePathFor("x.pdf").includes("uploads"));
  assert.ok(!certificateDir().includes(`${path.sep}uploads${path.sep}`));
});

/* ------------------------------------------------------------ storable */

test("only a certificate with a frozen snapshot is stored", () => {
  // Without a snapshot the document is still meant to follow the catalogue, so
  // caching it would freeze figures nobody asked to freeze.
  assert.equal(isStorable(null), false);
  assert.equal(isStorable({ certificate_number: "AA-1" }), false);
  assert.equal(isStorable({ certificate_number: "AA-1", issued_snapshot: null }), false);
  assert.equal(isStorable({ certificate_number: "AA-1", issued_snapshot: { version: 1 } }), true);
  assert.equal(isStorable({ certificate_number: "AA-1", issued_snapshot: '{"version":1}' }), true);
  // A snapshot with no usable number is not storable either.
  assert.equal(isStorable({ certificate_number: "  ", issued_snapshot: { version: 1 } }), false);
});

/* -------------------------------------------------------- round tripping */

test("a stored rendition is read back byte for byte", async () => {
  await inTempCwd(async () => {
    const buffer = Buffer.from("%PDF-1.4 pretend certificate", "utf8");
    const stored = await storeCertificatePdf({
      certificateNumber: "AA-CERT-2026-000042",
      locale: "fr",
      buffer,
      recordPath: false,
    });
    assert.equal(stored.ok, true);
    assert.equal(stored.relativePath, "storage/certificates/AA-CERT-2026-000042-fr.pdf");
    assert.equal(stored.bytes, buffer.length);

    const hit = readStoredCertificate("AA-CERT-2026-000042", "fr");
    assert.ok(hit, "the file should be found");
    assert.deepEqual(hit.buffer, buffer);
    assert.equal(hit.bytes, buffer.length);
    assert.equal(hit.relativePath, stored.relativePath);
  });
});

test("the other language is a different file, not an overwrite", async () => {
  await inTempCwd(async () => {
    await storeCertificatePdf({
      certificateNumber: "AA-1",
      locale: "fr",
      buffer: Buffer.from("french"),
      recordPath: false,
    });
    await storeCertificatePdf({
      certificateNumber: "AA-1",
      locale: "en",
      buffer: Buffer.from("english"),
      recordPath: false,
    });
    assert.equal(readStoredCertificate("AA-1", "fr").buffer.toString(), "french");
    assert.equal(readStoredCertificate("AA-1", "en").buffer.toString(), "english");
  });
});

test("nothing temporary is left behind", async () => {
  await inTempCwd(async () => {
    await storeCertificatePdf({
      certificateNumber: "AA-2",
      locale: "fr",
      buffer: Buffer.from("x"),
      recordPath: false,
    });
    const entries = fs.readdirSync(certificateDir());
    assert.deepEqual(entries, ["AA-2-fr.pdf"]);
  });
});

test("a missing file simply means re-render", async () => {
  await inTempCwd(() => {
    assert.equal(readStoredCertificate("AA-NOTHERE", "fr"), null);
    assert.equal(statStoredCertificate("AA-NOTHERE", "fr"), null);
  });
});

test("a zero-byte file is treated as absent rather than served as a PDF", async () => {
  await inTempCwd(() => {
    fs.mkdirSync(certificateDir(), { recursive: true });
    fs.writeFileSync(path.join(certificateDir(), "AA-3-fr.pdf"), Buffer.alloc(0));
    assert.equal(readStoredCertificate("AA-3", "fr"), null);
    assert.equal(statStoredCertificate("AA-3", "fr"), null);
  });
});

test("a directory where the file should be does not throw", async () => {
  await inTempCwd(() => {
    fs.mkdirSync(path.join(certificateDir(), "AA-4-fr.pdf"), { recursive: true });
    assert.equal(readStoredCertificate("AA-4", "fr"), null);
    assert.equal(statStoredCertificate("AA-4", "fr"), null);
  });
});

test("an empty buffer is never written", async () => {
  await inTempCwd(async () => {
    assert.equal(
      await storeCertificatePdf({ certificateNumber: "AA-5", locale: "fr", buffer: Buffer.alloc(0), recordPath: false }),
      null
    );
    assert.equal(fs.existsSync(certificateDir()), false);
  });
});

test("stat reports the size without reading the file", async () => {
  await inTempCwd(async () => {
    const buffer = Buffer.alloc(4096, 7);
    await storeCertificatePdf({ certificateNumber: "AA-6", locale: "en", buffer, recordPath: false });
    const stat = statStoredCertificate("AA-6", "en");
    assert.equal(stat.bytes, 4096);
    assert.equal(stat.relativePath, "storage/certificates/AA-6-en.pdf");
  });
});

test("the document limit is Meta's, in bytes", () => {
  assert.equal(MAX_DOCUMENT_BYTES, 100 * 1024 * 1024);
});
