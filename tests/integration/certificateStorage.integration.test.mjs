// tests/integration/certificateStorage.integration.test.mjs
//
// The issued certificate as a stored file.
//
// Two things could not be proven without a database. First, that the renderer
// writes the PDF once and serves that file afterwards, so the document a
// customer was given cannot quietly change when a logo or a layout does.
// Second — and this is why the file exists at all — that the frozen snapshot is
// actually applied to the payload. It was not: the payload builder returned the
// live object and the snapshot overlay sat below that return, unreachable, so
// every certificate was still drawn from live data. A unit test could not see
// it, because the builder needs a case, a plan and a sale to run at all.
//
// OPT-IN: set IT_DB_NAME to a throwaway database.
//
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { initializePool, getPool } from "../../utils/db.js";
import { issuePolicy } from "../../models/policyIssuance.js";
import {
  certificatePdfBufferForSaleId,
  certificateDocumentSize,
  getCertificatePageDataPublic,
} from "../../controllers/documentController.js";
import { certificateDir, statStoredCertificate } from "../../utils/certificateStore.js";

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

// A background renderer has no request to take the host from, so the stored
// copy's QR code comes from here.
process.env.PUBLIC_API_URL = process.env.PUBLIC_API_URL || "https://api.example.test";

const RUN = Date.now().toString().slice(-9);
const uniq = (p) => `${p}-${RUN}-${Math.floor(Math.random() * 10000)}`;

/** Nothing this test renders may land in the repository's uploads folder. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "certstore-it-"));
const REAL_CWD = process.cwd();
process.chdir(SANDBOX);

async function makeCase() {
  const pool = getPool();
  const [u] = await pool.execute(
    `INSERT INTO users (name, email, password, role) VALUES (?, ?, 'x', 'admin')`,
    ["IT cert storage", `${uniq("certstore")}@example.test`]
  );
  const [p] = await pool.execute(
    `INSERT INTO catalogue (product_type, name, coverage) VALUES ('Travel', ?, 'Medical, repatriation')`,
    [uniq("IT plan")]
  );
  const [t] = await pool.execute(
    `INSERT INTO travellers (first_name, last_name, passport_or_id, date_of_birth, nationality)
     VALUES ('Aya', 'Koné', 'CI9988776', '1988-06-02', 'Côte d''Ivoire')`
  );
  const [c] = await pool.execute(
    `INSERT INTO cases (traveller_id, destination, start_date, end_date, selected_plan_id, created_by)
     VALUES (?, 'France', '2026-11-01', '2026-11-10', ?, ?)`,
    [t.insertId, p.insertId, u.insertId]
  );
  return {
    caseId: c.insertId,
    travellerId: t.insertId,
    planId: p.insertId,
    userId: u.insertId,
    caseRow: {
      id: c.insertId,
      first_name: "Aya",
      last_name: "Koné",
      passport_or_id: "CI9988776",
      date_of_birth: "1988-06-02",
      nationality: "Côte d'Ivoire",
      destination: "France",
      start_date: "2026-11-01",
      end_date: "2026-11-10",
      duration_days: 10,
      plan_name: "IT plan",
      product_type: "Travel",
      coverage: "Medical, repatriation",
      currency: "XOF",
    },
  };
}

async function dropCase(f) {
  const pool = getPool();
  await pool.query("DELETE FROM certificates WHERE sale_id IN (SELECT id FROM sales WHERE case_id = ?)", [f.caseId]);
  await pool.query("DELETE FROM invoices WHERE sale_id IN (SELECT id FROM sales WHERE case_id = ?)", [f.caseId]);
  await pool.query("DELETE FROM sales WHERE case_id = ?", [f.caseId]);
  await pool.query("DELETE FROM cases WHERE id = ?", [f.caseId]);
  await pool.query("DELETE FROM travellers WHERE id = ?", [f.travellerId]);
  await pool.query("DELETE FROM catalogue WHERE id = ?", [f.planId]);
  await pool.query("DELETE FROM users WHERE id = ?", [f.userId]);
}

const PRICING = { premium: 20000, tax: 0, total: 20000, currency: "XOF", validityDays: 10 };

async function issueOne(f) {
  return issuePolicy({
    caseId: f.caseId,
    caseRow: f.caseRow,
    pricing: PRICING,
    paid: { method: "wave", reference: uniq("PAY"), amount: 20000 },
  });
}

/** Call an Express handler without Express. */
async function callHandler(handler, req) {
  let payload = null;
  let status = 200;
  const res = {
    status(code) { status = code; return res; },
    json(body) { payload = body; return res; },
    setHeader() { return res; },
    send(body) { payload = body; return res; },
  };
  await handler(req, res);
  return { status, payload };
}

/* ------------------------------------------------------- storing the file */

test("the first render writes the file and the second one serves it", { skip }, async () => {
  const pool = getPool();
  const f = await makeCase();
  try {
    const issued = await issueOne(f);

    const first = await certificatePdfBufferForSaleId(issued.saleId, null, { locale: "fr" });
    assert.ok(first, "the certificate must render");
    assert.equal(first.fromStore, false, "nothing was stored yet");
    assert.equal(first.pdfBuffer.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(first.pdfBuffer.length > 1000, "a real certificate is not a few bytes");

    const onDisk = path.join(certificateDir(), `${issued.certificateNumber}-fr.pdf`);
    assert.ok(fs.existsSync(onDisk), `expected ${onDisk} to be written`);
    assert.equal(fs.statSync(onDisk).size, first.pdfBuffer.length);

    const [[cert]] = await pool.query("SELECT pdf_path FROM certificates WHERE sale_id = ?", [issued.saleId]);
    assert.equal(
      cert.pdf_path,
      `storage/certificates/${issued.certificateNumber}-fr.pdf`,
      "pdf_path had no writer before this; it must point at the file now"
    );

    const second = await certificatePdfBufferForSaleId(issued.saleId, null, { locale: "fr" });
    assert.equal(second.fromStore, true, "the second call must come off the disk");
    assert.deepEqual(second.pdfBuffer, first.pdfBuffer, "byte for byte, or it is not the same document");
  } finally {
    await dropCase(f);
  }
});

test("the stored document does not change when the catalogue does", { skip }, async () => {
  const pool = getPool();
  const f = await makeCase();
  try {
    const issued = await issueOne(f);
    const before = await certificatePdfBufferForSaleId(issued.saleId, null, { locale: "fr" });

    // Exactly the edit that used to rewrite a travelling customer's document.
    await pool.execute("UPDATE catalogue SET name = ?, theme_color = '#00AA00' WHERE id = ?", [
      "Renamed after issuance",
      f.planId,
    ]);

    const after = await certificatePdfBufferForSaleId(issued.saleId, null, { locale: "fr" });
    assert.equal(after.fromStore, true);
    assert.deepEqual(after.pdfBuffer, before.pdfBuffer);
  } finally {
    await dropCase(f);
  }
});

test("French and English are separate files", { skip }, async () => {
  const f = await makeCase();
  try {
    const issued = await issueOne(f);
    const fr = await certificatePdfBufferForSaleId(issued.saleId, null, { locale: "fr" });
    const en = await certificatePdfBufferForSaleId(issued.saleId, null, { locale: "en" });
    assert.equal(fr.fromStore, false);
    assert.equal(en.fromStore, false, "English must render on its own, not reuse the French file");
    assert.notDeepEqual(fr.pdfBuffer, en.pdfBuffer, "the two languages are different documents");
    assert.ok(fs.existsSync(path.join(certificateDir(), `${issued.certificateNumber}-fr.pdf`)));
    assert.ok(fs.existsSync(path.join(certificateDir(), `${issued.certificateNumber}-en.pdf`)));
  } finally {
    await dropCase(f);
  }
});

test("deleting the stored file re-renders it instead of failing", { skip }, async () => {
  const f = await makeCase();
  try {
    const issued = await issueOne(f);
    await certificatePdfBufferForSaleId(issued.saleId, null, { locale: "fr" });
    fs.unlinkSync(path.join(certificateDir(), `${issued.certificateNumber}-fr.pdf`));

    const again = await certificatePdfBufferForSaleId(issued.saleId, null, { locale: "fr" });
    assert.equal(again.fromStore, false, "it has to render again");
    assert.equal(again.pdfBuffer.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(fs.existsSync(path.join(certificateDir(), `${issued.certificateNumber}-fr.pdf`)), "and store it again");
  } finally {
    await dropCase(f);
  }
});

test("a certificate with no snapshot is rendered live and never stored", { skip }, async () => {
  const pool = getPool();
  const f = await makeCase();
  try {
    const issued = await issueOne(f);
    await pool.execute("UPDATE certificates SET issued_snapshot = NULL WHERE sale_id = ?", [issued.saleId]);

    const first = await certificatePdfBufferForSaleId(issued.saleId, null, { locale: "fr" });
    const second = await certificatePdfBufferForSaleId(issued.saleId, null, { locale: "fr" });
    assert.equal(first.fromStore, false);
    assert.equal(second.fromStore, false, "a legacy certificate must keep following the catalogue");
    assert.equal(
      fs.existsSync(path.join(certificateDir(), `${issued.certificateNumber}-fr.pdf`)),
      false,
      "nothing should be written for it"
    );
  } finally {
    await dropCase(f);
  }
});

/* ------------------------------------------------------------ size guard */

test("the size of the delivered document is known without re-rendering it", { skip }, async () => {
  const f = await makeCase();
  try {
    const issued = await issueOne(f);
    const rendered = await certificatePdfBufferForSaleId(issued.saleId, null, { locale: "fr" });

    const stat = statStoredCertificate(issued.certificateNumber, "fr");
    assert.equal(stat.bytes, rendered.pdfBuffer.length);

    const sized = await certificateDocumentSize(issued.saleId, { locale: "fr" });
    assert.equal(sized.fromStore, true, "the stored file answers this without a render");
    assert.equal(sized.bytes, rendered.pdfBuffer.length);
    // The guard exists for the future; today's certificates are nowhere near it.
    assert.ok(sized.bytes < 1024 * 1024, `a certificate should be well under a megabyte, got ${sized.bytes}`);
  } finally {
    await dropCase(f);
  }
});

/* ------------------------------------------- the snapshot actually applies */

test("the public certificate payload is built from the snapshot, not from live data", { skip }, async () => {
  const pool = getPool();
  const f = await makeCase();
  try {
    const issued = await issueOne(f);
    const [[cert]] = await pool.query("SELECT public_token FROM certificates WHERE sale_id = ?", [issued.saleId]);

    // Rewrite everything the snapshot pins, the way a correction to the
    // catalogue or the traveller record would.
    await pool.execute("UPDATE catalogue SET name = 'Renamed plan' WHERE id = ?", [f.planId]);
    await pool.execute("UPDATE cases SET destination = 'Spain' WHERE id = ?", [f.caseId]);
    await pool.execute("UPDATE sales SET premium_amount = 1, total = 1 WHERE id = ?", [issued.saleId]);

    const { status, payload } = await callHandler(getCertificatePageDataPublic, {
      params: { token: cert.public_token },
      query: {},
      protocol: "https",
      get: (h) => (String(h).toLowerCase() === "host" ? "api.example.test" : ""),
    });

    assert.equal(status, 200);
    assert.equal(payload.issuedFromSnapshot, true, "the overlay must run — it was dead code before");
    assert.equal(payload.coverage.planName, "IT plan", "the plan name as issued, not as renamed");
    assert.equal(payload.coverage.destinations, "France", "the destination as issued");
    assert.equal(Number(payload.pricing.total), 20000, "the amount as issued, not the edited sale row");
    assert.equal(payload.traveller.passportOrId, "CI9988776");
  } finally {
    await dropCase(f);
  }
});

test("a certificate with no snapshot still renders, without the overlay", { skip }, async () => {
  const pool = getPool();
  const f = await makeCase();
  try {
    const issued = await issueOne(f);
    const [[cert]] = await pool.query("SELECT public_token FROM certificates WHERE sale_id = ?", [issued.saleId]);
    await pool.execute("UPDATE certificates SET issued_snapshot = NULL WHERE sale_id = ?", [issued.saleId]);

    const { status, payload } = await callHandler(getCertificatePageDataPublic, {
      params: { token: cert.public_token },
      query: {},
      protocol: "https",
      get: (h) => (String(h).toLowerCase() === "host" ? "api.example.test" : ""),
    });

    assert.equal(status, 200);
    assert.equal(payload.issuedFromSnapshot, undefined);
    assert.equal(payload.certificateNumber, issued.certificateNumber);
  } finally {
    await dropCase(f);
  }
});

test("closing the pool at the end", { skip }, async () => {
  await getPool().end();
  process.chdir(REAL_CWD);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  assert.ok(true);
});
