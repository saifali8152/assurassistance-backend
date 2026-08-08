/**
 * One-off: reassign travel agency "IT Voyages" from Admin to Sub-Admin Esther Ahouman.
 *
 * Usage (from backend/):
 *   node scripts/reassignItVoyagesToEsther.js
 *   node scripts/reassignItVoyagesToEsther.js --effective-from=2026-05-01 --dry-run
 *
 * Requires agency_supervision_history migration applied.
 * Does not alter sales, cases, policy numbers or agency codes — only created_by_id + history.
 */
import "dotenv/config";
import getPool from "../utils/db.js";
import { reassignAgencySupervisor, listSupervisionHistory } from "../models/agencySupervisionModel.js";

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const dryRun = process.argv.includes("--dry-run");
const effectiveFrom = argValue("effective-from", "2026-05-01");
const agencyNeedle = argValue("agency", "IT Voyages");
const supervisorNeedle = argValue("supervisor", "Esther Ahouman");

async function findOne(query, params, label) {
  const pool = getPool();
  const [rows] = await pool.query(query, params);
  if (!rows.length) {
    throw new Error(`${label} not found (search: ${JSON.stringify(params)})`);
  }
  if (rows.length > 1) {
    console.warn(
      `Warning: multiple matches for ${label}; using first:`,
      rows.map((r) => ({ id: r.id, name: r.name, company_name: r.company_name, email: r.email }))
    );
  }
  return rows[0];
}

async function main() {
  const agency = await findOne(
    `SELECT id, name, email, company_name, created_by_id, created_at, role, parent_agent_id
     FROM users
     WHERE role = 'agent'
       AND (parent_agent_id IS NULL OR parent_agent_id = 0)
       AND (company_name LIKE ? OR name LIKE ?)
     ORDER BY
       CASE WHEN company_name = ? OR name = ? THEN 0 ELSE 1 END,
       id ASC`,
    [`%${agencyNeedle}%`, `%${agencyNeedle}%`, agencyNeedle, agencyNeedle],
    `Agency "${agencyNeedle}"`
  );

  const esther = await findOne(
    `SELECT id, name, email, role
     FROM users
     WHERE role = 'sub_admin'
       AND (name LIKE ? OR email LIKE ?)
     ORDER BY
       CASE WHEN name = ? THEN 0 ELSE 1 END,
       id ASC`,
    [`%${supervisorNeedle}%`, `%${supervisorNeedle}%`, supervisorNeedle],
    `Sub-admin "${supervisorNeedle}"`
  );

  const pool = getPool();
  const [admins] = await pool.query(
    `SELECT id, name, email FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`
  );
  const adminUser = admins[0];
  if (!adminUser) throw new Error("No admin account found to record as changed_by");

  console.log("Agency:", {
    id: agency.id,
    name: agency.name,
    company_name: agency.company_name,
    created_by_id: agency.created_by_id,
  });
  console.log("New supervisor:", { id: esther.id, name: esther.name, email: esther.email });
  console.log("Effective from:", effectiveFrom);
  console.log("Changed by (admin):", { id: adminUser.id, name: adminUser.name });

  if (dryRun) {
    console.log("Dry run — no changes written.");
    process.exit(0);
  }

  const result = await reassignAgencySupervisor({
    agencyId: agency.id,
    newSupervisorId: esther.id,
    effectiveFrom,
    changedByUserId: adminUser.id,
    reason: `Transfer ${agency.company_name || agency.name} to ${esther.name}`,
  });

  const history = await listSupervisionHistory(agency.id);
  console.log("Reassignment complete. Management history:");
  for (const h of history) {
    const to = h.effective_to || "ongoing";
    console.log(
      `  ${h.effective_from} → ${to}: ${h.supervisor_name || "—"} (${h.supervisor_role || "?"})`
    );
  }
  console.log("Previous supervisor id:", result.previousSupervisorId);
  console.log("New supervisor id:", result.newSupervisorId);
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
