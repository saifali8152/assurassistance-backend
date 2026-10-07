// tests/integration/sales.integration.test.mjs
//
// The two guarantees that cannot be proven without a database:
//
//   1. Sequence allocation is atomic — N concurrent allocations produce N
//      distinct, consecutive values, never a repeat. This is what replaced
//      `POL-${Date.now()}`, which collided whenever two confirmations landed in
//      the same millisecond.
//   2. A case can hold only one LIVE sale. The controller checks first, but a
//      check in code is not a guarantee under concurrency, so the UNIQUE index
//      added by m3_03 is the backstop and is tested as such.
//
// OPT-IN BY DESIGN, exactly like the WhatsApp integration suite: these tests
// write rows, so they refuse to run unless pointed at a throwaway database.
//
//   IT_DB_NAME=assur_test IT_DB_HOST=127.0.0.1 IT_DB_USER=root IT_DB_PASSWORD= \
//     node --test tests/integration/*.test.mjs
//
import test from "node:test";
import assert from "node:assert/strict";

import { initializePool, getPool } from "../../utils/db.js";
import { allocateSequence, allocateSaleNumbers } from "../../utils/documentNumbers.js";
import { createSale } from "../../models/salesModel.js";

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

const RUN = Date.now().toString().slice(-9);
const uniq = (p) => `${p}-${RUN}-${Math.floor(Math.random() * 10000)}`;

/** Minimal user + plan + traveller + case, enough to hang a sale off. */
async function makeCase() {
  const pool = getPool();
  const [u] = await pool.execute(
    `INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'admin')`,
    ["IT user", `${uniq("it")}@example.test`, "x"]
  );
  const [p] = await pool.execute(
    `INSERT INTO catalogue (product_type, name, coverage) VALUES ('Travel', ?, 'IT coverage')`,
    [uniq("IT plan")]
  );
  const [t] = await pool.execute(
    `INSERT INTO travellers (first_name, last_name) VALUES (?, ?)`,
    ["Integration", "Tester"]
  );
  const [c] = await pool.execute(
    `INSERT INTO cases (traveller_id, destination, start_date, end_date, selected_plan_id, created_by)
     VALUES (?, 'France', '2026-11-01', '2026-11-10', ?, ?)`,
    [t.insertId, p.insertId, u.insertId]
  );
  return { caseId: c.insertId, travellerId: t.insertId, planId: p.insertId, userId: u.insertId };
}

async function dropCase({ caseId, travellerId, planId, userId }) {
  const pool = getPool();
  await pool.query("DELETE FROM certificates WHERE sale_id IN (SELECT id FROM sales WHERE case_id = ?)", [caseId]);
  await pool.query("DELETE FROM invoices WHERE sale_id IN (SELECT id FROM sales WHERE case_id = ?)", [caseId]);
  await pool.query("DELETE FROM sales WHERE case_id = ?", [caseId]);
  await pool.query("DELETE FROM cases WHERE id = ?", [caseId]);
  await pool.query("DELETE FROM travellers WHERE id = ?", [travellerId]);
  await pool.query("DELETE FROM catalogue WHERE id = ?", [planId]);
  await pool.query("DELETE FROM users WHERE id = ?", [userId]);
}

/* ------------------------------------------------------ sequence allocation */

test("concurrent allocations of one sequence never repeat a value", { skip }, async () => {
  const pool = getPool();
  const seqKey = uniq("it-seq").slice(0, 40);
  const N = 12;

  // Each allocation takes its own connection, which is the real shape: several
  // PM2 workers confirming sales at the same moment.
  const values = await Promise.all(
    Array.from({ length: N }, async () => {
      const conn = await pool.getConnection();
      try {
        return await allocateSequence(conn, seqKey, "ALL");
      } finally {
        conn.release();
      }
    })
  );

  const unique = new Set(values);
  assert.equal(unique.size, N, `expected ${N} distinct values, got ${[...unique].length}`);
  assert.deepEqual([...values].sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i + 1));

  await pool.query("DELETE FROM policy_sequences WHERE seq_key = ?", [seqKey]);
});

test("a sequence counts per period, so two periods do not share a counter", { skip }, async () => {
  const pool = getPool();
  const seqKey = uniq("it-per").slice(0, 40);
  const conn = await pool.getConnection();
  try {
    assert.equal(await allocateSequence(conn, seqKey, "2026"), 1);
    assert.equal(await allocateSequence(conn, seqKey, "2026"), 2);
    assert.equal(await allocateSequence(conn, seqKey, "2027"), 1);
  } finally {
    conn.release();
    await pool.query("DELETE FROM policy_sequences WHERE seq_key = ?", [seqKey]);
  }
});

test("allocateSaleNumbers renders all three numbers from their formats", { skip }, async () => {
  const pool = getPool();
  const conn = await pool.getConnection();
  const suffix = RUN.slice(-4);
  try {
    const nums = await allocateSaleNumbers(conn, {
      policy: `ITP${suffix}-{YYYY}-{SEQ:5}`,
      invoice: `ITI${suffix}-{SEQ:5}`,
      certificate: `ITC${suffix}-{SEQ:5}`,
    });
    assert.match(nums.policyNumber, new RegExp(`^ITP${suffix}-\\d{4}-\\d{5}$`));
    assert.match(nums.invoiceNumber, new RegExp(`^ITI${suffix}-\\d{5}$`));
    assert.match(nums.certificateNumber, new RegExp(`^ITC${suffix}-\\d{5}$`));
  } finally {
    conn.release();
  }
});

/* ------------------------------------------------- one live sale per case */

test("a second live sale on the same case is refused by the database", { skip }, async () => {
  const fixture = await makeCase();
  try {
    const first = await createSale({
      case_id: fixture.caseId,
      policy_number: uniq("POL"),
      certificate_number: uniq("CERT"),
      premium_amount: 100,
      tax: 0,
      total: 100,
    });
    assert.ok(first > 0);

    await assert.rejects(
      () =>
        createSale({
          case_id: fixture.caseId,
          policy_number: uniq("POL"),
          certificate_number: uniq("CERT"),
          premium_amount: 100,
          tax: 0,
          total: 100,
        }),
      (err) => {
        assert.equal(err.code, "ER_DUP_ENTRY");
        assert.match(String(err.sqlMessage), /uq_sales_active_case/);
        return true;
      },
      "the second sale should have been refused"
    );
  } finally {
    await dropCase(fixture);
  }
});

test("a soft-deleted sale frees the case for a replacement", { skip }, async () => {
  const pool = getPool();
  const fixture = await makeCase();
  try {
    const first = await createSale({
      case_id: fixture.caseId,
      policy_number: uniq("POL"),
      certificate_number: uniq("CERT"),
      premium_amount: 100,
      tax: 0,
      total: 100,
    });
    await pool.execute(`UPDATE sales SET deleted_at = NOW() WHERE id = ?`, [first]);

    // Cancelling a policy and issuing a corrected one is a real workflow, so
    // the constraint must only bind live rows.
    const second = await createSale({
      case_id: fixture.caseId,
      policy_number: uniq("POL"),
      certificate_number: uniq("CERT"),
      premium_amount: 120,
      tax: 0,
      total: 120,
    });
    assert.ok(second > first);
  } finally {
    await dropCase(fixture);
  }
});

test("concurrent sale inserts on one case leave exactly one live sale", { skip }, async () => {
  const pool = getPool();
  const fixture = await makeCase();
  try {
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        createSale({
          case_id: fixture.caseId,
          policy_number: uniq("POL"),
          certificate_number: uniq("CERT"),
          premium_amount: 100,
          tax: 0,
          total: 100,
        })
      )
    );

    const ok = attempts.filter((a) => a.status === "fulfilled");
    assert.equal(ok.length, 1, `expected 1 insert to win, ${ok.length} did`);

    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM sales WHERE case_id = ? AND deleted_at IS NULL`,
      [fixture.caseId]
    );
    assert.equal(Number(rows[0].n), 1);
  } finally {
    await dropCase(fixture);
  }
});

test("closing the pool at the end", { skip }, async () => {
  await getPool().end();
  assert.ok(true);
});
