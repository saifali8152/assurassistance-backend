// scripts/refreshCertificateSnapshots.js
//
// Bring a certificate's frozen snapshot back in line with its case.
//
// WHY THIS EXISTS. Until now a policy edit updated the case, the sale and the
// invoice but not the certificate snapshot, so a corrected policy kept printing
// the details it was issued with. The edit path now re-freezes the snapshot
// itself; this script is for the policies that were edited BEFORE that fix and
// are still carrying stale documents.
//
// It changes no money. Pricing is taken from the sale row — what the customer
// was actually charged — not recomputed, so a catalogue change since issuance
// cannot alter a premium through this script.
//
// USAGE
//   node scripts/refreshCertificateSnapshots.js --dry-run --edited
//   node scripts/refreshCertificateSnapshots.js --edited
//   node scripts/refreshCertificateSnapshots.js --sale=123
//   node scripts/refreshCertificateSnapshots.js --case=572
//
//   --edited    every live policy whose policy_edit_count is above zero
//   --sale=     one sale id
//   --case=     one case id
//   --dry-run   report only, write nothing
//
import dotenv from "dotenv";
import { initializePool, getPool } from "../utils/db.js";
import { getCaseDetailsById } from "../models/caseModel.js";
import { refreshIssuedSnapshot } from "../models/policyIssuance.js";
import { invalidateStoredCertificate } from "../utils/certificateStore.js";

dotenv.config();

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const EDITED = args.includes("--edited");
const saleArg = args.find((a) => a.startsWith("--sale="));
const caseArg = args.find((a) => a.startsWith("--case="));

function usage(message) {
  console.error(`[snapshots] ${message}`);
  console.error("[snapshots] usage: --edited | --sale=<id> | --case=<id>  [--dry-run]");
  process.exit(1);
}

async function targets(pool) {
  if (saleArg) {
    const id = Number(saleArg.split("=")[1]);
    if (!Number.isFinite(id)) usage("--sale needs a number");
    const [rows] = await pool.query(
      `SELECT id AS sale_id, case_id FROM sales WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    return rows;
  }
  if (caseArg) {
    const id = Number(caseArg.split("=")[1]);
    if (!Number.isFinite(id)) usage("--case needs a number");
    const [rows] = await pool.query(
      `SELECT id AS sale_id, case_id FROM sales WHERE case_id = ? AND deleted_at IS NULL`,
      [id]
    );
    return rows;
  }
  if (EDITED) {
    const [rows] = await pool.query(
      `SELECT s.id AS sale_id, s.case_id
         FROM sales s
         JOIN certificates c ON c.sale_id = s.id
        WHERE s.deleted_at IS NULL
          AND COALESCE(s.policy_edit_count, 0) > 0
        ORDER BY s.id ASC`
    );
    return rows;
  }
  return usage("say which policies: --edited, --sale= or --case=");
}

async function main() {
  initializePool(process.env);
  const pool = getPool();
  const rows = await targets(pool);
  console.log(`[snapshots] ${rows.length} policy(ies) selected${DRY ? " — dry run, nothing will be written" : ""}`);

  let refreshed = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const label = `sale ${row.sale_id} (case ${row.case_id})`;
    try {
      const [[sale]] = await pool.query(
        `SELECT premium_amount, tax, total, currency, plan_price FROM sales WHERE id = ?`,
        [row.sale_id]
      );
      const caseRow = await getCaseDetailsById(row.case_id);
      if (!caseRow) {
        console.warn(`[snapshots] ${label}: case not found, skipped`);
        skipped += 1;
        continue;
      }

      if (DRY) {
        const [[cert]] = await pool.query(
          `SELECT issued_snapshot FROM certificates WHERE sale_id = ? LIMIT 1`,
          [row.sale_id]
        );
        let snap = cert?.issued_snapshot;
        if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch { snap = null; } }
        if (!snap) {
          console.log(`[snapshots] ${label}: no snapshot (pre-m3_07) — left alone`);
          skipped += 1;
          continue;
        }
        const drift = [];
        if ((snap.trip?.destination ?? null) !== (caseRow.destination ?? null)) {
          drift.push(`destination "${snap.trip?.destination}" -> "${caseRow.destination}"`);
        }
        if (String(snap.traveller?.passport_or_id ?? "") !== String(caseRow.passport_or_id ?? "")) {
          drift.push("passport");
        }
        if (String(snap.plan?.name ?? "") !== String(caseRow.plan_name ?? "")) {
          drift.push(`plan "${snap.plan?.name}" -> "${caseRow.plan_name}"`);
        }
        console.log(
          drift.length
            ? `[snapshots] ${label}: WOULD REFRESH — ${drift.join("; ")}`
            : `[snapshots] ${label}: already in step`
        );
        refreshed += drift.length ? 1 : 0;
        skipped += drift.length ? 0 : 1;
        continue;
      }

      const result = await refreshIssuedSnapshot({
        saleId: row.sale_id,
        caseRow,
        pricing: {
          premium: Number(sale?.premium_amount) || 0,
          tax: Number(sale?.tax) || 0,
          total: Number(sale?.total) || 0,
          currency: sale?.currency || caseRow.currency || "XOF",
          planPrice: Number(sale?.plan_price) || 0,
          validityDays: null,
          ageBand: null,
        },
        reason: "backfill_after_edit",
        byUserId: null,
      });

      if (!result.ok) {
        console.log(`[snapshots] ${label}: skipped (${result.reason})`);
        skipped += 1;
        continue;
      }
      const dropped = invalidateStoredCertificate(result.certificateNumber);
      console.log(
        `[snapshots] ${label}: refreshed ${result.certificateNumber}` +
          (dropped.length ? ` — dropped ${dropped.length} stored PDF(s)` : "")
      );
      refreshed += 1;
    } catch (err) {
      console.error(`[snapshots] ${label}: FAILED — ${err.message}`);
      failed += 1;
    }
  }

  console.log(`[snapshots] refreshed ${refreshed} · skipped ${skipped} · failed ${failed}`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("[snapshots] fatal:", err);
  process.exit(1);
});
