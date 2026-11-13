// utils/loginLockout.js
//
// Milestone 5 — lock an ACCOUNT after repeated wrong passwords (m5_03).
//
// The IP limiter already slows one address; this stops one account being
// guessed from many. After LOGIN_MAX_FAILURES wrong passwords in a row the
// account is locked for LOGIN_LOCK_MINUTES; a correct password (once
// unlocked) or a password reset clears the count.
//
// Before m5_03 has run, the columns do not exist: every function here then
// does nothing, and login behaves exactly as it did.
//
import getPool from "./db.js";

export const MAX_FAILURES = Math.max(3, Number(process.env.LOGIN_MAX_FAILURES) || 5);
export const LOCK_MINUTES = Math.max(1, Number(process.env.LOGIN_LOCK_MINUTES) || 15);

/** @returns { locked:boolean, retryAfterMinutes? } */
export async function accountLock(userId) {
  try {
    const [[row]] = await getPool().query(
      `SELECT locked_until > NOW() AS locked, CEIL(TIMESTAMPDIFF(SECOND, NOW(), locked_until) / 60) AS mins FROM users WHERE id = ?`,
      [userId]
    );
    return Number(row?.locked) === 1 ? { locked: true, retryAfterMinutes: Math.max(1, Number(row.mins) || 1) } : { locked: false };
  } catch {
    return { locked: false };
  }
}

/** One more wrong password. Locks when the threshold is reached. */
export async function recordFailedLogin(userId) {
  try {
    await getPool().execute(
      `UPDATE users
          -- Order matters: MySQL applies SET left to right using the values
          -- already updated, so the lock is decided before the count moves.
          SET locked_until = IF(failed_login_count + 1 >= ?, NOW() + INTERVAL ? MINUTE, locked_until),
              failed_login_count = failed_login_count + 1
        WHERE id = ?`,
      [MAX_FAILURES, LOCK_MINUTES, userId]
    );
    const [[row]] = await getPool().query(`SELECT failed_login_count AS n, locked_until > NOW() AS locked FROM users WHERE id = ?`, [userId]);
    return { failures: Number(row?.n || 0), locked: Number(row?.locked) === 1 };
  } catch {
    return { failures: 0, locked: false };
  }
}

export async function clearFailedLogins(userId) {
  try {
    await getPool().execute(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ? AND (failed_login_count <> 0 OR locked_until IS NOT NULL)`, [userId]);
  } catch {
    /* columns not there yet */
  }
}
