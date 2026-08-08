/**
 * Agency supervision (ownership) history — who manages a travel agency / partner, by period.
 * Live scope still uses users.created_by_id on the top-level agency row.
 */
import getPool from "../utils/db.js";

function toDateOnly(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function dayBefore(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function getTopLevelAgencyById(agencyId) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, u.company_name, u.role, u.created_by_id, u.parent_agent_id,
            u.created_at, u.partnership_type, u.status,
            s.id AS supervisor_id, s.name AS supervisor_name, s.email AS supervisor_email, s.role AS supervisor_role
     FROM users u
     LEFT JOIN users s ON s.id = u.created_by_id
     WHERE u.id = ? AND u.role = 'agent'
       AND (u.parent_agent_id IS NULL OR u.parent_agent_id = 0)
     LIMIT 1`,
    [agencyId]
  );
  return rows[0] || null;
}

export async function listSupervisionHistory(agencyId) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT h.id, h.agency_user_id, h.supervisor_user_id, h.effective_from, h.effective_to,
            h.changed_by_user_id, h.reason, h.created_at,
            s.name AS supervisor_name, s.email AS supervisor_email, s.role AS supervisor_role,
            c.name AS changed_by_name, c.email AS changed_by_email
     FROM agency_supervision_history h
     LEFT JOIN users s ON s.id = h.supervisor_user_id
     LEFT JOIN users c ON c.id = h.changed_by_user_id
     WHERE h.agency_user_id = ?
     ORDER BY h.effective_from ASC, h.id ASC`,
    [agencyId]
  );
  return rows.map((r) => ({
    ...r,
    effective_from: toDateOnly(r.effective_from),
    effective_to: toDateOnly(r.effective_to),
    is_current: r.effective_to == null,
  }));
}

/**
 * Ensure there is an open history row for the agency (backfill from created_at if empty).
 */
export async function ensureOpenSupervisionPeriod(agency, changedByUserId) {
  const pool = getPool();
  const [open] = await pool.query(
    `SELECT id FROM agency_supervision_history
     WHERE agency_user_id = ? AND effective_to IS NULL
     ORDER BY id DESC LIMIT 1`,
    [agency.id]
  );
  if (open.length) return open[0].id;

  const [any] = await pool.query(
    `SELECT id FROM agency_supervision_history WHERE agency_user_id = ? LIMIT 1`,
    [agency.id]
  );
  if (any.length) return null;

  const from = toDateOnly(agency.created_at) || new Date().toISOString().slice(0, 10);
  const [result] = await pool.execute(
    `INSERT INTO agency_supervision_history
       (agency_user_id, supervisor_user_id, effective_from, effective_to, changed_by_user_id, reason)
     VALUES (?, ?, ?, NULL, ?, ?)`,
    [
      agency.id,
      agency.created_by_id || null,
      from,
      changedByUserId,
      "Initial supervision period (auto-recorded)",
    ]
  );
  return result.insertId;
}

/**
 * Reassign top-level agency to a new supervisor (sub_admin or admin).
 * Does not touch sales/cases — only users.created_by_id + history periods.
 *
 * @returns {{ agency, history, previousSupervisorId, newSupervisorId }}
 */
export async function reassignAgencySupervisor({
  agencyId,
  newSupervisorId,
  effectiveFrom,
  changedByUserId,
  reason = null,
}) {
  const pool = getPool();
  const agency = await getTopLevelAgencyById(agencyId);
  if (!agency) {
    const err = new Error("Agency not found (must be a top-level partner / travel agency)");
    err.status = 404;
    throw err;
  }

  const fromDate = toDateOnly(effectiveFrom) || new Date().toISOString().slice(0, 10);
  let supervisorId = newSupervisorId == null || newSupervisorId === "" ? null : Number(newSupervisorId);

  if (supervisorId != null) {
    const [supRows] = await pool.query(
      `SELECT id, name, email, role FROM users WHERE id = ? LIMIT 1`,
      [supervisorId]
    );
    if (!supRows.length) {
      const err = new Error("Supervisor account not found");
      err.status = 404;
      throw err;
    }
    const role = supRows[0].role;
    if (role !== "sub_admin" && role !== "admin") {
      const err = new Error("Supervisor must be a sub-administrator or admin account");
      err.status = 400;
      throw err;
    }
  }

  const previousSupervisorId = agency.created_by_id != null ? Number(agency.created_by_id) : null;
  if (previousSupervisorId === supervisorId) {
    const err = new Error("Agency is already assigned to this supervising account");
    err.status = 400;
    throw err;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [histCount] = await conn.query(
      `SELECT COUNT(*) AS n FROM agency_supervision_history WHERE agency_user_id = ?`,
      [agency.id]
    );
    const [openRows] = await conn.query(
      `SELECT id, effective_from FROM agency_supervision_history
       WHERE agency_user_id = ? AND effective_to IS NULL
       ORDER BY id ASC`,
      [agency.id]
    );

    if (Number(histCount[0].n) === 0) {
      const start = toDateOnly(agency.created_at) || fromDate;
      if (start < fromDate) {
        await conn.execute(
          `INSERT INTO agency_supervision_history
             (agency_user_id, supervisor_user_id, effective_from, effective_to, changed_by_user_id, reason)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            agency.id,
            previousSupervisorId,
            start,
            dayBefore(fromDate),
            changedByUserId,
            "Period before reassignment (auto-recorded)",
          ]
        );
      }
    } else {
      const closeTo = dayBefore(fromDate);
      for (const row of openRows) {
        const openFrom = toDateOnly(row.effective_from) || fromDate;
        const effectiveClose = closeTo >= openFrom ? closeTo : openFrom;
        await conn.execute(
          `UPDATE agency_supervision_history SET effective_to = ? WHERE id = ?`,
          [effectiveClose, row.id]
        );
      }
    }

    await conn.execute(
      `INSERT INTO agency_supervision_history
         (agency_user_id, supervisor_user_id, effective_from, effective_to, changed_by_user_id, reason)
       VALUES (?, ?, ?, NULL, ?, ?)`,
      [agency.id, supervisorId, fromDate, changedByUserId, reason || null]
    );

    await conn.execute(`UPDATE users SET created_by_id = ? WHERE id = ?`, [
      supervisorId,
      agency.id,
    ]);

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  const history = await listSupervisionHistory(agency.id);
  const refreshed = await getTopLevelAgencyById(agency.id);
  return {
    agency: refreshed,
    history,
    previousSupervisorId,
    newSupervisorId: supervisorId,
  };
}

/** Record initial supervision when an agency is created. */
export async function recordInitialSupervision({
  agencyUserId,
  supervisorUserId,
  changedByUserId,
  effectiveFrom = null,
}) {
  const pool = getPool();
  const from = toDateOnly(effectiveFrom) || new Date().toISOString().slice(0, 10);
  await pool.execute(
    `INSERT INTO agency_supervision_history
       (agency_user_id, supervisor_user_id, effective_from, effective_to, changed_by_user_id, reason)
     VALUES (?, ?, ?, NULL, ?, ?)`,
    [agencyUserId, supervisorUserId || null, from, changedByUserId, "Agency created"]
  );
}
