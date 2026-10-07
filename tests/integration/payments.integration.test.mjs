// tests/integration/payments.integration.test.mjs
//
// The Day 1-2 exit criterion: the abstraction layer, end to end against a real
// database, including the three cases that actually break payment systems —
// a duplicate callback, an out-of-order callback, and a timeout.
//
// OPT-IN, like the other integration suites: it writes rows, so it refuses to
// run unless pointed at a throwaway database.
//
//   IT_DB_NAME=assur_test IT_DB_HOST=127.0.0.1 IT_DB_USER=root IT_DB_PASSWORD= \
//     node --test tests/integration/*.test.mjs
//
import test from "node:test";
import assert from "node:assert/strict";

import { initializePool, getPool } from "../../utils/db.js";
import {
  createTransaction,
  getTransactionById,
  getTransactionByProviderTx,
  getTransactionByReference,
  setProviderTxId,
  transition,
  recordCallback,
  markCallbackProcessed,
  findExpirable,
  findPending,
  attachSale,
} from "../../models/paymentModel.js";
import { getProvider } from "../../utils/payments/provider.js";
import { buildMockCallback } from "../../utils/payments/mock.js";

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

const KEY = () => `it-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function wipe(reference) {
  const pool = getPool();
  await pool.query(
    "DELETE FROM payment_callbacks WHERE transaction_id IN (SELECT id FROM payment_transactions WHERE reference = ?)",
    [reference]
  );
  await pool.query("DELETE FROM payment_transactions WHERE reference = ?", [reference]);
}

async function start(overrides = {}) {
  const { transaction } = await createTransaction({
    provider: "mock",
    idempotencyKey: KEY(),
    msisdn: "2250712345678",
    amount: 15000,
    currency: "XOF",
    timeoutMinutes: 15,
    ...overrides,
  });
  return transaction;
}

/* ------------------------------------------------------------- the happy path */

test("a transaction walks pending to completed and records every move", { skip }, async () => {
  const tx = await start();
  try {
    assert.equal(tx.status, "pending");
    assert.match(tx.reference, /^PAY-\d{4}-\d{6}$/);

    assert.equal((await transition(tx.id, "initiated", { by: "test" })).ok, true);
    assert.equal((await transition(tx.id, "awaiting_confirmation", { by: "test" })).ok, true);
    assert.equal((await transition(tx.id, "completed", { by: "provider:mock" })).ok, true);

    const done = await getTransactionById(tx.id);
    assert.equal(done.status, "completed");
    assert.ok(done.completed_at, "completed_at should be stamped");
    assert.ok(done.initiated_at, "initiated_at should be stamped");

    // created + three moves
    assert.equal(done.status_history.length, 4);
    assert.equal(done.status_history.at(-1).to, "completed");
    assert.equal(done.status_history.at(-1).by, "provider:mock");
  } finally {
    await wipe(tx.reference);
  }
});

/* --------------------------------------------------------------- idempotency */

test("the same idempotency key returns the first transaction, never a second", { skip }, async () => {
  const key = KEY();
  const first = await createTransaction({ provider: "mock", idempotencyKey: key, amount: 100, currency: "XOF" });
  const second = await createTransaction({ provider: "mock", idempotencyKey: key, amount: 100, currency: "XOF" });
  try {
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.transaction.id, first.transaction.id);
  } finally {
    await wipe(first.transaction.reference);
  }
});

test("concurrent first attempts with one key create exactly one transaction", { skip }, async () => {
  const key = KEY();
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      createTransaction({ provider: "mock", idempotencyKey: key, amount: 100, currency: "XOF" })
    )
  );
  const ids = new Set(results.map((r) => r.transaction.id));
  try {
    assert.equal(ids.size, 1, "every caller must receive the same transaction");
    assert.equal(results.filter((r) => !r.duplicate).length, 1);
  } finally {
    await wipe(results[0].transaction.reference);
  }
});

test("references are unique across concurrent creations", { skip }, async () => {
  const made = await Promise.all(Array.from({ length: 8 }, () => start()));
  try {
    assert.equal(new Set(made.map((t) => t.reference)).size, 8);
  } finally {
    for (const t of made) await wipe(t.reference);
  }
});

/* ------------------------------------------------------- duplicate callbacks */

test("a redelivered callback is archived as a duplicate and acted on once", { skip }, async () => {
  const tx = await start();
  try {
    const providerTxId = `mock_dup_${Date.now()}`;
    await setProviderTxId(tx.id, providerTxId);
    await transition(tx.id, "initiated", { by: "test" });
    await transition(tx.id, "awaiting_confirmation", { by: "test" });

    const first = await recordCallback({ provider: "mock", rawBody: "{}", providerTxId, signatureValid: true });
    assert.equal(first.duplicate, false);
    // Only a PROCESSED callback marks later ones as duplicates — an archived
    // but unprocessed delivery must still be allowed to do its work.
    await markCallbackProcessed(first.id, { transactionId: tx.id });

    const second = await recordCallback({ provider: "mock", rawBody: "{}", providerTxId, signatureValid: true });
    assert.equal(second.duplicate, true, "the redelivery must be flagged");

    // And the state machine itself refuses to act twice.
    const again = await transition(tx.id, "completed", { by: "provider:mock" });
    assert.equal(again.ok, true);
    const noop = await transition(tx.id, "completed", { by: "provider:mock" });
    assert.equal(noop.noop, true, "a repeat of the same outcome is a no-op");
  } finally {
    await wipe(tx.reference);
  }
});

test("concurrent transitions to completed produce one real move and the rest no-ops", { skip }, async () => {
  const tx = await start();
  try {
    await transition(tx.id, "awaiting_confirmation", { by: "test" });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => transition(tx.id, "completed", { by: "provider:mock" }))
    );
    const real = results.filter((r) => r.ok && !r.noop);
    assert.equal(real.length, 1, `exactly one move expected, got ${real.length}`);
    assert.equal(results.filter((r) => r.noop).length, 5);

    const done = await getTransactionById(tx.id);
    assert.equal(done.status_history.filter((h) => h.to === "completed").length, 1);
  } finally {
    await wipe(tx.reference);
  }
});

/* ------------------------------------------------------ out-of-order callbacks */

test("a late failure callback cannot undo a completed payment", { skip }, async () => {
  const tx = await start();
  try {
    await transition(tx.id, "awaiting_confirmation", { by: "test" });
    await transition(tx.id, "completed", { by: "provider:mock" });

    const late = await transition(tx.id, "failed", {
      by: "provider:mock",
      failureCode: "insufficient_funds",
    });
    assert.equal(late.ok, false);
    assert.equal(late.reason, "terminal_state");

    const after = await getTransactionById(tx.id);
    assert.equal(after.status, "completed", "the policy must not be revoked by a late callback");
    assert.equal(after.failure_code, null);
  } finally {
    await wipe(tx.reference);
  }
});

test("a provider id cannot be repointed once set", { skip }, async () => {
  const tx = await start();
  try {
    assert.equal(await setProviderTxId(tx.id, "mock_first"), true);
    assert.equal(await setProviderTxId(tx.id, "mock_second"), false);
    const found = await getTransactionByProviderTx("mock", "mock_first");
    assert.equal(found.id, tx.id);
    assert.equal(await getTransactionByProviderTx("mock", "mock_second"), null);
  } finally {
    await wipe(tx.reference);
  }
});

/* --------------------------------------------------------------- the timeout */

test("a transaction past its window is found by the sweeper and expires", { skip }, async () => {
  const pool = getPool();
  const tx = await start({ timeoutMinutes: 2 });
  try {
    await transition(tx.id, "awaiting_confirmation", { by: "test" });
    await pool.execute(
      `UPDATE payment_transactions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?`,
      [tx.id]
    );

    const due = await findExpirable(100);
    assert.ok(due.some((t) => t.id === tx.id), "the sweeper should see it");

    const r = await transition(tx.id, "expired", { by: "sweeper", note: "no callback in time" });
    assert.equal(r.ok, true);

    const after = await getTransactionById(tx.id);
    assert.equal(after.status, "expired");

    const dueAgain = await findExpirable(100);
    assert.ok(!dueAgain.some((t) => t.id === tx.id), "an expired transaction must not be swept twice");
  } finally {
    await wipe(tx.reference);
  }
});

test("a completed transaction is never swept", { skip }, async () => {
  const pool = getPool();
  const tx = await start({ timeoutMinutes: 2 });
  try {
    await transition(tx.id, "awaiting_confirmation", { by: "test" });
    await transition(tx.id, "completed", { by: "provider:mock" });
    await pool.execute(
      `UPDATE payment_transactions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?`,
      [tx.id]
    );
    const due = await findExpirable(100);
    assert.ok(!due.some((t) => t.id === tx.id));
  } finally {
    await wipe(tx.reference);
  }
});

test("findPending returns only transactions still waiting", { skip }, async () => {
  const waiting = await start();
  const settled = await start();
  try {
    await transition(waiting.id, "awaiting_confirmation", { by: "test" });
    await transition(settled.id, "awaiting_confirmation", { by: "test" });
    await transition(settled.id, "completed", { by: "test" });

    const pending = await findPending(500);
    const ids = pending.map((t) => t.id);
    assert.ok(ids.includes(waiting.id));
    assert.ok(!ids.includes(settled.id));
  } finally {
    await wipe(waiting.reference);
    await wipe(settled.reference);
  }
});

/* ------------------------------------------- the provider, through the layer */

test("the mock provider initiates and its signed callback parses", { skip }, async () => {
  const provider = getProvider("mock");
  const tx = await start();
  try {
    const init = await provider.initiatePayment({
      reference: tx.reference,
      amount: Number(tx.amount),
      currency: tx.currency,
      msisdn: tx.msisdn,
    });
    assert.equal(init.ok, true);
    assert.equal(init.status, "awaiting_confirmation");
    await setProviderTxId(tx.id, init.providerTxId);

    const { body, headers } = buildMockCallback({
      reference: tx.reference,
      providerTxId: init.providerTxId,
      status: "completed",
      secret: "it-secret",
    });
    const parsed = provider.handleCallback({ rawBody: body, headers, config: { callbackSecret: "it-secret" } });
    assert.equal(parsed.valid, true);
    assert.equal(parsed.status, "completed");

    const matched = await getTransactionByReference(parsed.reference);
    assert.equal(matched.id, tx.id);

    await transition(tx.id, "initiated", { by: "test" });
    await transition(tx.id, "awaiting_confirmation", { by: "test" });
    assert.equal((await transition(tx.id, parsed.status, { by: "provider:mock" })).ok, true);
    assert.equal((await getTransactionById(tx.id)).status, "completed");
  } finally {
    await wipe(tx.reference);
  }
});

test("a callback signed with the wrong secret is refused", { skip }, async () => {
  const provider = getProvider("mock");
  const { body, headers } = buildMockCallback({
    reference: "PAY-2026-000001",
    providerTxId: "mock_x",
    status: "completed",
    secret: "right",
  });
  const parsed = provider.handleCallback({ rawBody: body, headers, config: { callbackSecret: "wrong" } });
  assert.equal(parsed.valid, false);
  assert.equal(parsed.reason, "signature_mismatch");
});

test("a sale can be attached once and only once", { skip }, async () => {
  const tx = await start();
  try {
    assert.equal(await attachSale(tx.id, 4242), true);
    assert.equal(await attachSale(tx.id, 9999), false);
    assert.equal((await getTransactionById(tx.id)).sale_id, 4242);
  } finally {
    await wipe(tx.reference);
  }
});

test("closing the pool at the end", { skip }, async () => {
  await getPool().end();
  assert.ok(true);
});
