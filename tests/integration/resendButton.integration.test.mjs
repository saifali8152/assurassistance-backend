// tests/integration/resendButton.integration.test.mjs
//
// Milestone 5, Day 10 — the "Re-send certificate on WhatsApp" button. Until
// Meta is connected it must say so plainly (409), and only staff may use it.
//
// OPT-IN: set IT_DB_NAME to a throwaway database that has been migrated.
//
import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "it-secret";
const express = (await import("express")).default;
const jwt = (await import("jsonwebtoken")).default;
const { initializePool, getPool } = await import("../../utils/db.js");
const salesRoute = (await import("../../routes/salesRoute.js")).default;

const CONFIGURED = Boolean(process.env.IT_DB_NAME);
const skip = CONFIGURED ? false : "set IT_DB_NAME to run integration tests";
let server, base;
if (CONFIGURED) {
  initializePool({
    DB_HOST: process.env.IT_DB_HOST || "127.0.0.1", DB_PORT: Number(process.env.IT_DB_PORT || 3306),
    DB_USER: process.env.IT_DB_USER || "root", DB_PASSWORD: process.env.IT_DB_PASSWORD || "", DB_NAME: process.env.IT_DB_NAME,
  });
  const app = express();
  app.use(express.json());
  app.use("/api/sales", salesRoute);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
}
const tok = (role) => jwt.sign({ id: 1, role }, process.env.JWT_SECRET);
const post = (role, url, body = {}) => fetch(`${base}${url}`, { method: "POST", headers: { Authorization: `Bearer ${tok(role)}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("agents cannot use it; staff get a plain 'not connected' while Meta is not live", { skip }, async () => {
  assert.equal((await post("agent", "/api/sales/1/resend-whatsapp")).status, 403);
  await getPool().query(`UPDATE app_settings SET setting_value = '0' WHERE setting_key = 'whatsapp.enabled'`);
  const r = await post("admin", "/api/sales/1/resend-whatsapp");
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, "whatsapp_not_ready");
});

test.after(async () => {
  if (!CONFIGURED) return;
  server.close();
  await getPool().end();
});
