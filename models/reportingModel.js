// src/models/reportingModel.js
//
// The numbers behind the daily summary.
//
// Deliberately a model rather than inline SQL in a script: the same figures will
// be wanted on a screen later, and a report whose definition lives in a cron
// job is a report nobody can reconcile against the ledger.
//
import getPool from "../utils/db.js";

/**
 * Everything that happened on one day.
 *
 * `day` is a YYYY-MM-DD string in the server's timezone — which is what the
 * client means by "yesterday", not a UTC window that cuts their evening in two.
 */
export async function dailyActivity(day) {
  const pool = getPool();

  const [[policies]] = await pool.query(
    `SELECT COUNT(*) AS issued,
            COALESCE(SUM(total), 0) AS total_value,
            COALESCE(SUM(CASE WHEN payment_status = 'Paid' THEN total ELSE 0 END), 0) AS paid_value,
            SUM(payment_status = 'Paid')   AS paid,
            SUM(payment_status = 'Unpaid') AS unpaid,
            SUM(payment_status = 'Partial') AS partial
       FROM sales
      WHERE DATE(confirmed_at) = ? AND deleted_at IS NULL`,
    [day]
  );

  const [payments] = await pool.query(
    `SELECT status, provider, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount
       FROM payment_transactions
      WHERE DATE(created_at) = ?
      GROUP BY status, provider
      ORDER BY status, provider`,
    [day]
  );

  const [failures] = await pool.query(
    `SELECT failure_code, COUNT(*) AS n
       FROM payment_transactions
      WHERE DATE(created_at) = ? AND status IN ('failed','expired')
        AND failure_code IS NOT NULL
      GROUP BY failure_code
      ORDER BY n DESC`,
    [day]
  );

  const [[conversations]] = await pool.query(
    `SELECT COUNT(*) AS started,
            SUM(status = 'completed') AS completed,
            SUM(status = 'escalated') AS escalated,
            SUM(status = 'cancelled') AS cancelled
       FROM whatsapp_sessions
      WHERE DATE(created_at) = ?`,
    [day]
  );

  // Things a human should look at today, not at month end.
  const [[attention]] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM payment_transactions
         WHERE status IN ('pending','initiated','awaiting_confirmation')
           AND expires_at < NOW())                                  AS stuck_payments,
       (SELECT COUNT(*) FROM payment_callbacks
         WHERE processed = 1 AND transaction_id IS NULL
           AND DATE(received_at) = ?)                               AS unmatched_callbacks,
       (SELECT COUNT(*) FROM payment_transactions
         WHERE status = 'completed' AND sale_id IS NULL)            AS paid_without_policy`,
    [day]
  );

  return {
    day,
    policies: {
      issued: Number(policies.issued) || 0,
      totalValue: Number(policies.total_value) || 0,
      paidValue: Number(policies.paid_value) || 0,
      paid: Number(policies.paid) || 0,
      unpaid: Number(policies.unpaid) || 0,
      partial: Number(policies.partial) || 0,
    },
    payments: payments.map((r) => ({
      status: r.status,
      provider: r.provider,
      count: Number(r.n),
      amount: Number(r.amount),
    })),
    failures: failures.map((r) => ({ code: r.failure_code, count: Number(r.n) })),
    conversations: {
      started: Number(conversations.started) || 0,
      completed: Number(conversations.completed) || 0,
      escalated: Number(conversations.escalated) || 0,
      cancelled: Number(conversations.cancelled) || 0,
    },
    attention: {
      stuckPayments: Number(attention.stuck_payments) || 0,
      unmatchedCallbacks: Number(attention.unmatched_callbacks) || 0,
      paidWithoutPolicy: Number(attention.paid_without_policy) || 0,
    },
  };
}
