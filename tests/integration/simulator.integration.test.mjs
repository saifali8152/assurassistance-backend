// tests/integration/simulator.integration.test.mjs
//
// Milestone 5, Day 12 — the WhatsApp simulator (D11), over real HTTP, with
// the real engine, the real claim journey and the real database.
//
// It files a whole claim against an imported test policy — including a
// document upload — while the claims switch is OFF, and checks what the
// simulator must never do: touch cases, travellers or sales.
//
// OPT-IN: set IT_DB_NAME to a throwaway database that has been migrated.
//
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

process.env.JWT_SECRET = process.env.JWT_SECRET || "it-secret";
process.env.CLAIMS_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sim-"));

const express = (await import("express")).default;
const jwt = (await import("jsonwebtoken")).default;
const { initializePool, getPool } = await import("../../utils/db.js");
const routes = (await import("../../routes/simulatorRoutes.js")).default;
const { passportColumns } = await import("../../utils/travellerPrivacy.js");
const { CLAIMS_FLAG, setFlag, clearFlagCache } = await import("../../utils/featureFlags.js");
const { invalidateAccessCache } = await import("../../models/accessModel.js");
const { getCategory } = await import("../../models/claimCategoryModel.js");
const { simulatorNumber } = (await import("../../controllers/simulatorController.js")).__testables;

const CONFIGURED = Boolean(process.env.IT_DB_NAME);
const skip = CONFIGURED ? false : "set IT_DB_NAME to run integration tests";
let server, base, admin, agent;
const RUN = Date.now().toString().slice(-6);

if (CONFIGURED) {
  initializePool({
    DB_HOST: process.env.IT_DB_HOST || "127.0.0.1", DB_PORT: Number(process.env.IT_DB_PORT || 3306),
    DB_USER: process.env.IT_DB_USER || "root", DB_PASSWORD: process.env.IT_DB_PASSWORD || "", DB_NAME: process.env.IT_DB_NAME,
  });
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/admin/simulator", routes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
}

const tok = (id, role) => jwt.sign({ id, role }, process.env.JWT_SECRET);
async function user(role) {
  const [r] = await getPool().execute(`INSERT INTO users (name, email, password, role, status) VALUES ('IT sim', ?, 'x', ?, 'active')`, [`sim-${RUN}-${role}-${Math.random()}@example.test`, role]);
  invalidateAccessCache();
  return { id: r.insertId, token: tok(r.insertId, role) };
}
const send = async (u, body) => {
  const r = await fetch(`${base}/api/admin/simulator/message`, { method: "POST", headers: { Authorization: `Bearer ${u.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
};
const counts = async () => {
  const out = {};
  for (const t of ["cases", "travellers", "sales", "invoices", "certificates"]) {
    const [[r]] = await getPool().query(`SELECT COUNT(*) AS n FROM ${t}`);
    out[t] = Number(r.n);
  }
  return out;
};

const PDF = Buffer.from("%PDF-1.4\nsimulated police report\n%%EOF\n", "latin1");

test("only simulator.use: an agent is refused", { skip }, async () => {
  agent = await user("agent");
  const r = await send(agent, { text: "Bonjour" });
  assert.equal(r.status, 403);
});

test("a full test claim through the simulator, with claims switched OFF for the public", { skip }, async () => {
  admin = await user("admin");
  await setFlag(CLAIMS_FLAG, false);
  clearFlagCache();
  const before = await counts();

  // An imported test policy to claim against.
  const pp = `SIM${RUN}`;
  const cols = passportColumns(pp);
  const policyNumber = `SIMPOL-${RUN}`;
  await getPool().execute(
    `INSERT INTO external_policies (policy_number, holder_first_name, holder_last_name, passport_or_id_enc, passport_or_id_hash, start_date, end_date, is_test, source)
     VALUES (?, 'TEST', 'SIMULATOR', ?, ?, CURDATE() - INTERVAL 10 DAY, CURDATE() + INTERVAL 10 DAY, 1, 'manual')`,
    [policyNumber, cols.passport_or_id_enc, cols.passport_or_id_hash]
  );
  await fetch(`${base}/api/admin/simulator/reset`, { method: "POST", headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" }, body: "{}" });

  let r = await send(admin, { text: "Bonjour" });
  assert.equal(r.status, 200);
  assert.equal(r.replies[0].kind, "list", "claims are visible in the simulator even while off");
  assert.match(r.waNumber, /^999/);

  r = await send(admin, { selectionId: "menu:claim" });
  assert.equal(r.session.step, "claim_identify");
  r = await send(admin, { text: policyNumber });
  r = await send(admin, { text: pp });
  assert.equal(r.session.step, "claim_policy_confirm");
  r = await send(admin, { selectionId: "claim:policy_yes" });
  assert.ok(r.session.claimId, `draft created — ${JSON.stringify(r)}`);
  const claimId = r.session.claimId;

  // A file sent too early is attached rather than refused.
  r = await send(admin, { file: { name: "early.pdf", mime: "application/pdf", base64: PDF.toString("base64") } });
  assert.equal(r.session.step, "claim_category");

  await send(admin, { selectionId: "cat:travel" });
  await send(admin, { selectionId: "sub:theft" });
  const d = new Date(); d.setDate(d.getDate() - 2);
  await send(admin, { text: `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` });
  await send(admin, { text: "France" });
  r = await send(admin, { text: "Paris" });
  const theft = await getCategory("theft");
  for (const f of theft.extraFields) {
    r = f.type === "choice" ? await send(admin, { selectionId: `opt:${f.options[0].value}` })
      : await send(admin, { text: f.type === "number" ? String(f.min ?? 100) : f.type === "date" ? "01/11/2026" : "PV-123" });
  }
  r = await send(admin, { text: "On m'a volé mon sac à la gare avec mes papiers." });
  assert.equal(r.session.step, "claim_documents");
  r = await send(admin, { file: { name: "plainte.pdf", mime: "application/pdf", base64: PDF.toString("base64") } });
  assert.equal(r.session.step, "claim_documents");
  r = await send(admin, { text: "TERMINÉ" });
  if (r.session.step === "claim_documents") r = await send(admin, { selectionId: "claim:docs_later" });
  assert.equal(r.session.step, "claim_review");
  r = await send(admin, { selectionId: "claim:submit" });
  assert.equal(r.session.step, "claim_closed");

  const [[claim]] = await getPool().query(`SELECT status, is_test, reference FROM claims WHERE id = ?`, [claimId]);
  assert.equal(claim.status, "submitted");
  assert.equal(claim.is_test, 1, "a simulator claim is a test claim");
  assert.match(claim.reference, /^SIN-/);
  const [[docs]] = await getPool().query(`SELECT COUNT(*) AS n FROM claim_documents WHERE claim_id = ? AND status = 'stored'`, [claimId]);
  assert.equal(Number(docs.n), 2, "both files stored");

  assert.deepEqual(await counts(), before, "no case, traveller, sale, invoice or certificate written");
  const [[transcript]] = await getPool().query(`SELECT COUNT(*) AS n FROM whatsapp_messages WHERE wa_number = ? AND status = 'simulated'`, [simulatorNumber(admin.id)]);
  assert.ok(Number(transcript.n) > 10, "the transcript is kept, marked simulated");
});

test("the purchase journey in the simulator ends without writing a quote", { skip }, async () => {
  const before = await counts();
  await fetch(`${base}/api/admin/simulator/reset`, { method: "POST", headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" }, body: "{}" });
  await send(admin, { text: "Bonjour" });
  const r = await send(admin, { selectionId: "menu:buy" });
  assert.equal(r.session.step, "identity");
  assert.deepEqual(await counts(), before);
});

test.after(async () => {
  fs.rmSync(process.env.CLAIMS_STORAGE_DIR, { recursive: true, force: true });
  if (!CONFIGURED) return;
  server.close();
  await getPool().end();
});
