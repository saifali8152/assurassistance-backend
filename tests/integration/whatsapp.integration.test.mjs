// tests/integration/whatsapp.integration.test.mjs
//
// The parts of the WhatsApp module that CANNOT be proven without a database:
// the advisory lock that serialises a customer's messages, the unique-active-
// session constraint, webhook deduplication under concurrency, session expiry
// boundaries, and the retention prune.
//
// OPT-IN BY DESIGN. These tests create and delete rows, so they refuse to run
// unless you point them at a throwaway database explicitly:
//
//   IT_DB_NAME=assur_test IT_DB_HOST=127.0.0.1 IT_DB_USER=root IT_DB_PASSWORD= \
//     node --test tests/integration/*.test.mjs
//
// They deliberately do NOT read DB_NAME from .env — that is the production
// database, and a test suite must never be one typo away from it.
//
import test from "node:test";
import assert from "node:assert/strict";

import { initializePool, getPool } from "../../utils/db.js";
import {
  withNumberLock,
  createSession,
  getActiveSession,
  updateSession,
  closeSession,
  expireStaleSessions,
  recordInboundMessage,
  recordOutboundMessage,
  pruneOldMessages,
  getSessionById,
} from "../../models/whatsappModel.js";

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

/** Unique per run, so repeated runs never collide. */
const NUM = () => `999${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 900 + 100)}`;

async function cleanup(waNumber) {
  const pool = getPool();
  await pool.query("DELETE FROM whatsapp_messages WHERE wa_number = ?", [waNumber]);
  await pool.query("DELETE FROM whatsapp_sessions WHERE wa_number = ?", [waNumber]);
}

/* ------------------------------------------------------------ the lock */

test("withNumberLock serialises concurrent handling of one number", { skip }, async () => {
  const waNumber = NUM();
  const events = [];

  // Ten "webhook deliveries" for the same customer, all at once. Without the
  // lock these interleave and the conversation advances several steps from one
  // customer message.
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      withNumberLock(waNumber, async () => {
        events.push(`start:${i}`);
        await new Promise((r) => setTimeout(r, 25));
        events.push(`end:${i}`);
      })
    )
  );

  const ran = events.filter((e) => e.startsWith("start:")).length;
  assert.ok(ran >= 1, "at least one holder ran");

  // Every start must be immediately followed by its own end.
  for (let i = 0; i < events.length; i += 2) {
    const [, startId] = events[i].split(":");
    assert.ok(events[i].startsWith("start:"), `position ${i} should be a start, got ${events[i]}`);
    assert.equal(events[i + 1], `end:${startId}`, `overlapping critical sections around ${events[i]}`);
  }

  await cleanup(waNumber);
});

test("two different numbers are NOT blocked by each other", { skip }, async () => {
  const a = NUM();
  const b = NUM();
  const order = [];
  await Promise.all([
    withNumberLock(a, async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 60));
      order.push("a-end");
    }),
    withNumberLock(b, async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("b-ran");
    }),
  ]);
  assert.equal(order[0], "a-start");
  assert.equal(order[1], "b-ran", "b must not wait for a's lock");
  await cleanup(a);
  await cleanup(b);
});

/* ----------------------------------------------- one active session only */

test("a number can have only one active session", { skip }, async () => {
  const waNumber = NUM();
  await createSession({ waNumber, language: "fr", currentStep: "welcome", timeoutHours: 24 });

  await assert.rejects(
    () => createSession({ waNumber, language: "fr", currentStep: "welcome", timeoutHours: 24 }),
    /Duplicate|unique|uq_whatsapp_sessions_active/i,
    "the generated-column unique index must reject a second active session"
  );

  // Once the first is closed, a new conversation may begin.
  const active = await getActiveSession(waNumber);
  await closeSession(active.id, "completed");
  const second = await createSession({ waNumber, language: "fr", currentStep: "welcome", timeoutHours: 24 });
  assert.ok(second.id);

  await cleanup(waNumber);
});

/* --------------------------------------------- webhook deduplication */

test("concurrent redeliveries of one message id insert exactly one row", { skip }, async () => {
  const waNumber = NUM();
  const session = await createSession({ waNumber, language: "fr", currentStep: "welcome" });
  const waMessageId = `wamid.CONC.${Date.now()}`;

  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      recordInboundMessage({
        sessionId: session.id,
        waNumber,
        waMessageId,
        messageType: "text",
        body: "Bonjour",
      })
    )
  );

  const inserted = results.filter((r) => !r.duplicate);
  const duplicates = results.filter((r) => r.duplicate);
  assert.equal(inserted.length, 1, "exactly one delivery is processed");
  assert.equal(duplicates.length, 5, "the rest are reported as duplicates");

  const pool = getPool();
  const [[{ n }]] = await pool.query(
    "SELECT COUNT(*) AS n FROM whatsapp_messages WHERE wa_message_id = ?",
    [waMessageId]
  );
  assert.equal(n, 1);

  await cleanup(waNumber);
});

test("messages without a Meta id are all kept (queued outbound)", { skip }, async () => {
  const waNumber = NUM();
  const session = await createSession({ waNumber, language: "fr", currentStep: "welcome" });
  await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      recordOutboundMessage({ sessionId: session.id, waNumber, body: `reply ${i}` })
    )
  );
  const pool = getPool();
  const [[{ n }]] = await pool.query(
    "SELECT COUNT(*) AS n FROM whatsapp_messages WHERE wa_number = ? AND direction = 'outbound'",
    [waNumber]
  );
  assert.equal(n, 3, "a UNIQUE index on a nullable column must allow many NULLs");
  await cleanup(waNumber);
});

/* ------------------------------------------------- expiry boundaries */

test("only sessions past their window expire, and their data survives", { skip }, async () => {
  const pool = getPool();
  const numbers = { oneHour: NUM(), twelveHour: NUM(), pastDue: NUM(), future: NUM() };

  const collected = { first_name: "Awa", last_name: "Diallo", email: "awa@example.com" };
  for (const n of Object.values(numbers)) {
    await createSession({ waNumber: n, language: "fr", currentStep: "email", collectedData: collected });
  }

  // Ages measured against a 24h window: 1h and 12h are inside it, 25h is not.
  await pool.query("UPDATE whatsapp_sessions SET expires_at = DATE_ADD(NOW(), INTERVAL 23 HOUR) WHERE wa_number = ?", [numbers.oneHour]);
  await pool.query("UPDATE whatsapp_sessions SET expires_at = DATE_ADD(NOW(), INTERVAL 12 HOUR) WHERE wa_number = ?", [numbers.twelveHour]);
  await pool.query("UPDATE whatsapp_sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE wa_number = ?", [numbers.pastDue]);
  await pool.query("UPDATE whatsapp_sessions SET expires_at = NULL WHERE wa_number = ?", [numbers.future]);

  await expireStaleSessions();

  const statusOf = async (n) => {
    const [[row]] = await pool.query("SELECT status FROM whatsapp_sessions WHERE wa_number = ? LIMIT 1", [n]);
    return row.status;
  };

  assert.equal(await statusOf(numbers.oneHour), "active", "1h of inactivity must not expire");
  assert.equal(await statusOf(numbers.twelveHour), "active", "12h of inactivity must not expire");
  assert.equal(await statusOf(numbers.pastDue), "expired", "past the window it expires");
  assert.equal(await statusOf(numbers.future), "active", "a session with no expiry is left alone");

  // Resume depends on the collected data outliving expiry.
  const [[expired]] = await pool.query(
    "SELECT collected_data FROM whatsapp_sessions WHERE wa_number = ? LIMIT 1",
    [numbers.pastDue]
  );
  const data = typeof expired.collected_data === "string" ? JSON.parse(expired.collected_data) : expired.collected_data;
  assert.equal(data.first_name, "Awa", "an expired conversation keeps what the customer told us");
  assert.equal(data.email, "awa@example.com");

  for (const n of Object.values(numbers)) await cleanup(n);
});

test("activity pushes the expiry window out", { skip }, async () => {
  const waNumber = NUM();
  const session = await createSession({ waNumber, language: "fr", currentStep: "email", timeoutHours: 24 });
  const pool = getPool();

  await pool.query("UPDATE whatsapp_sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id = ?", [session.id]);
  await updateSession(session.id, { currentStep: "plan", timeoutHours: 24 });

  await expireStaleSessions();
  const after = await getSessionById(session.id);
  assert.equal(after.status, "active", "a session that just moved must not be expired");
  assert.equal(after.currentStep, "plan");

  await cleanup(waNumber);
});

/* ------------------------------------------------------ retention prune */

test("the prune deletes only messages past the retention window", { skip }, async () => {
  const waNumber = NUM();
  const session = await createSession({ waNumber, language: "fr", currentStep: "welcome" });
  const pool = getPool();

  const mk = async (body, daysAgo) => {
    const { id } = await recordInboundMessage({
      sessionId: session.id, waNumber, waMessageId: `wamid.${body}.${Date.now()}${Math.random()}`, body,
    });
    await pool.query("UPDATE whatsapp_messages SET created_at = DATE_SUB(NOW(), INTERVAL ? DAY) WHERE id = ?", [daysAgo, id]);
  };
  await mk("recent", 1);
  await mk("borderline", 29);
  await mk("old", 31);
  await mk("ancient", 400);

  const deleted = await pruneOldMessages(30);
  assert.equal(deleted, 2, "only the two beyond 30 days go");

  const [rows] = await pool.query("SELECT body FROM whatsapp_messages WHERE wa_number = ? ORDER BY id", [waNumber]);
  assert.deepEqual(rows.map((r) => r.body).sort(), ["borderline", "recent"]);

  // The prune must never touch the conversation itself.
  const stillThere = await getSessionById(session.id);
  assert.ok(stillThere, "pruning transcripts must not delete the session");

  await cleanup(waNumber);
});

test("the prune refuses a retention window shorter than a week", { skip }, async () => {
  const waNumber = NUM();
  const session = await createSession({ waNumber, language: "fr", currentStep: "welcome" });
  const pool = getPool();
  const { id } = await recordInboundMessage({ sessionId: session.id, waNumber, waMessageId: `wamid.floor.${Date.now()}`, body: "x" });
  await pool.query("UPDATE whatsapp_messages SET created_at = DATE_SUB(NOW(), INTERVAL 3 DAY) WHERE id = ?", [id]);

  // A caller passing 0 or 1 must not wipe recent transcripts; the floor is 7 days.
  const deleted = await pruneOldMessages(0);
  assert.equal(deleted, 0, "a 3-day-old message survives because the floor is 7 days");

  await cleanup(waNumber);
});

test("closing the pool at the end", { skip }, async () => {
  await getPool().end();
  assert.ok(true);
});
