// tests/integration/claimTranscriptPrivacy.integration.test.mjs
//
// Who may read WhatsApp transcripts and send through /api/whatsapp:
//   * a partner API key — by its scopes (whatsapp:read / whatsapp:write), and it
//     NEVER sees a claim conversation (D10: claims are status-only for partners);
//   * a signed-in user — only the main admin (the only role with the WhatsApp
//     Conversations screen). Agents, sub-admins and Claims handlers get 403.
//
// OPT-IN: set IT_DB_NAME to a throwaway database that has been migrated.
//
import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "it-secret";
const express = (await import("express")).default;
const jwt = (await import("jsonwebtoken")).default;
const { initializePool, getPool } = await import("../../utils/db.js");
const routes = (await import("../../routes/whatsappRoutes.js")).default;
const { generateApiKeySecret, insertApiKey } = await import("../../models/apiKeyModel.js");
const { invalidateAccessCache } = await import("../../models/accessModel.js");

const CONFIGURED = Boolean(process.env.IT_DB_NAME);
const skip = CONFIGURED ? false : "set IT_DB_NAME to run integration tests";
const RUN = Date.now().toString().slice(-6);
let server, base, claimSession, purchaseSession, admin, agent, handler, supervisor, partnerKey;

if (CONFIGURED) {
  initializePool({
    DB_HOST: process.env.IT_DB_HOST || "127.0.0.1", DB_PORT: Number(process.env.IT_DB_PORT || 3306),
    DB_USER: process.env.IT_DB_USER || "root", DB_PASSWORD: process.env.IT_DB_PASSWORD || "", DB_NAME: process.env.IT_DB_NAME,
  });
  const app = express();
  app.use(express.json());
  app.use("/api/whatsapp", routes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
}

async function user(role) {
  const [r] = await getPool().execute(`INSERT INTO users (name, email, password, role, status) VALUES ('IT tp', ?, 'x', ?, 'active')`, [`tp-${RUN}-${role}-${Math.random()}@example.test`, role]);
  return { id: r.insertId, token: jwt.sign({ id: r.insertId, role }, process.env.JWT_SECRET) };
}
async function session(flowKey, wa) {
  const [r] = await getPool().execute(
    `INSERT INTO whatsapp_sessions (wa_number, wa_profile_name, language, flow_key, current_step, collected_data, status, expires_at, last_activity_at)
     VALUES (?, 'IT', 'fr', ?, ?, '{}', 'active', NOW() + INTERVAL 1 DAY, NOW())`,
    [wa, flowKey, flowKey === "claim" ? "claim_description" : "identity"]
  );
  return r.insertId;
}
async function message(sessionId, wa, step, body) {
  await getPool().execute(
    `INSERT INTO whatsapp_messages (session_id, wa_number, direction, message_type, body, step_key, status) VALUES (?, ?, 'inbound', 'text', ?, ?, 'received')`,
    [sessionId, wa, body, step]
  );
}
const call = async (auth, url, init = {}) => {
  const r = await fetch(`${base}${url}`, { ...init, headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  let body = null;
  try { body = await r.json(); } catch { /* empty */ }
  return { status: r.status, body };
};

test("setup: one claim conversation, one purchase conversation that switched into a claim", { skip }, async () => {
  const waC = `2259${RUN}1`, waP = `2259${RUN}2`;
  claimSession = await session("claim", waC);
  await message(claimSession, waC, "claim_description", "Hospitalisée à Lyon — TP-SECRET-1");
  purchaseSession = await session("purchase", waP);
  await message(purchaseSession, waP, "identity", "Bonjour");
  await message(purchaseSession, waP, "claim_passport", "TP-SECRET-2");

  admin = await user("admin");
  agent = await user("agent");
  supervisor = await user("insurer_supervisor");
  handler = await user("sub_admin");
  const [[role]] = await getPool().query(`SELECT id FROM access_roles WHERE code = 'claims_handler'`);
  await getPool().execute(`UPDATE users SET access_role_id = ? WHERE id = ?`, [role.id, handler.id]);
  invalidateAccessCache();

  const s = generateApiKeySecret();
  await insertApiKey({ ownerUserId: admin.id, name: `tp-${RUN}`, keyPrefix: s.keyPrefix, keyHash: s.keyHash, scopes: ["whatsapp:read"], createdByUserId: admin.id });
  partnerKey = s.fullKey;
});

test("partner key (whatsapp:read): purchase transcripts yes, claim conversations never", { skip }, async () => {
  const list = await call(partnerKey, `/api/whatsapp/sessions?search=2259${RUN}&limit=100`);
  assert.equal(list.status, 200);
  const ids = list.body.data.map((s) => s.id);
  assert.ok(!ids.includes(claimSession), "claim session listed");
  assert.ok(ids.includes(purchaseSession), "purchase session still listed");
  assert.equal((await call(partnerKey, `/api/whatsapp/sessions/${claimSession}`)).status, 404);
  assert.equal((await call(partnerKey, `/api/whatsapp/sessions/${claimSession}/messages`)).status, 404);
  const msgs = await call(partnerKey, `/api/whatsapp/sessions/${purchaseSession}/messages`);
  const dump = JSON.stringify(msgs.body);
  assert.ok(dump.includes("Bonjour"), "purchase messages kept");
  assert.ok(!dump.includes("TP-SECRET"), "claim-step message leaked");
  assert.equal((await call(partnerKey, `/api/whatsapp/messages`, { method: "POST", body: JSON.stringify({ to: "2250700000000", text: "x" }) })).status, 403,
    "whatsapp:read alone cannot send");
});

for (const who of ["agent", "insurer supervisor", "sub-admin with the Claims handler role"]) {
  test(`${who} JWT: no transcripts, no sending`, { skip }, async () => {
    const auth = who === "agent" ? agent.token : who.startsWith("insurer") ? supervisor.token : handler.token;
    for (const url of [
      `/api/whatsapp/sessions?search=2259${RUN}`,
      `/api/whatsapp/sessions/${purchaseSession}`,
      `/api/whatsapp/sessions/${purchaseSession}/messages`,
      `/api/whatsapp/sessions/${claimSession}/messages`,
      `/api/whatsapp/stats`,
    ]) {
      const r = await call(auth, url);
      assert.equal(r.status, 403, `${url} → ${r.status}`);
      assert.ok(!JSON.stringify(r.body).includes("TP-SECRET"));
    }
    const send = await call(auth, `/api/whatsapp/messages`, { method: "POST", body: JSON.stringify({ to: "2250700000000", text: "hello" }) });
    assert.equal(send.status, 403, "a non-admin must not send WhatsApp messages");
  });
}

test("admin JWT: every conversation in full, claims included", { skip }, async () => {
  const list = await call(admin.token, `/api/whatsapp/sessions?search=2259${RUN}&limit=100`);
  assert.equal(list.status, 200);
  assert.ok(list.body.data.some((s) => s.id === claimSession));
  assert.ok(list.body.data.some((s) => s.id === purchaseSession));
  const msgs = await call(admin.token, `/api/whatsapp/sessions/${claimSession}/messages`);
  assert.equal(msgs.status, 200);
  assert.ok(JSON.stringify(msgs.body).includes("TP-SECRET-1"));
  const mixed = await call(admin.token, `/api/whatsapp/sessions/${purchaseSession}/messages`);
  assert.ok(JSON.stringify(mixed.body).includes("TP-SECRET-2"));
  assert.equal((await call(admin.token, `/api/whatsapp/stats`)).status, 200);
});

test("the non-secret status endpoint stays open to any signed-in user", { skip }, async () => {
  assert.equal((await call(agent.token, `/api/whatsapp/status`)).status, 200);
});

test.after(async () => {
  if (!CONFIGURED) return;
  server.close();
  await getPool().end();
});
