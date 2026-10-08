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
//   --drifted   every live policy whose snapshot no longer matches its case
//               (USE THIS ONE — it finds the policies that are actually wrong)
//   --edited    every live policy whose policy_edit_count is above zero. Note
//               that counter only moves for OPERATOR-role edits, so an admin or
//               sub-admin correction does not appear here. Kept for the operator
//               edit limit, not useful for finding stale certificates.
//   --sale=     one sale id
//   --case=     one case id
//   --id=       try it as a sale id, then as a case id
//   --dry-run   report only, write nothing
//   --live-only every policy EXCEPT soft-deleted ones. Off by default, because a
//               soft-deleted policy in this platform still issues its
//               certificate — so its snapshot has to stay correct like any
//               other's. Excluding them was what hid case 572.
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
const DRIFTED = args.includes("--drifted");
const LIVE = args.includes("--live-only");
/**
 * Soft-deleted policies are INCLUDED by default. They stay visible in the admin
 * panel and their certificates are still downloadable, so a stale snapshot on
 * one is just as wrong as on any other policy — and filtering them out is
 * exactly why case 572 came back empty four times.
 */
const LIVE_ONLY = LIVE ? " AND s.deleted_at IS NULL" : "";
const saleArg = args.find((a) => a.startsWith("--sale="));
const caseArg = args.find((a) => a.startsWith("--case="));
const idArg = args.find((a) => a.startsWith("--id="));

function usage(message) {
  console.error(`[snapshots] ${message}`);
  console.error("[snapshots] usage: --drifted | --edited | --sale=<id> | --case=<id> | --id=<id>  [--dry-run]");
  process.exit(1);
}

async function targets(pool) {
  if (saleArg) {
    const id = Number(saleArg.split("=")[1]);
    if (!Number.isFinite(id)) usage("--sale needs a number");
    const [rows] = await pool.query(
      `SELECT id AS sale_id, case_id FROM sales s WHERE id = ?${LIVE_ONLY}`,
      [id]
    );
    return rows;
  }
  if (caseArg) {
    const id = Number(caseArg.split("=")[1]);
    if (!Number.isFinite(id)) usage("--case needs a number");
    const [rows] = await pool.query(
      `SELECT id AS sale_id, case_id FROM sales s WHERE case_id = ?${LIVE_ONLY}`,
      [id]
    );
    return rows;
  }
  if (idArg) {
    const id = Number(idArg.split("=")[1]);
    if (!Number.isFinite(id)) usage("--id needs a number");
    const [bySale] = await pool.query(
      `SELECT id AS sale_id, case_id FROM sales s WHERE id = ?${LIVE_ONLY}`,
      [id]
    );
    if (bySale.length) {
      console.log(`[snapshots] ${id} matched a sale`);
      return bySale;
    }
    const [byCase] = await pool.query(
      `SELECT id AS sale_id, case_id FROM sales s WHERE case_id = ?${LIVE_ONLY}`,
      [id]
    );
    if (byCase.length) console.log(`[snapshots] ${id} matched a case`);
    return byCase;
  }
  if (DRIFTED) {
    // Compare the snapshot against the case itself rather than trusting an edit
    // counter: policy_edit_count only moves for operator-role edits, so an admin
    // correction leaves no trace on it. Drift is the thing we actually care
    // about, and it is directly observable.
    //
    // Dates come out of the driver as JS Date objects, so the snapshot stores
    // them as full ISO timestamps — hence the prefix comparison rather than an
    // equality test.
    const [rows] = await pool.query(
      `SELECT s.id AS sale_id, s.case_id
         FROM sales s
         JOIN certificates c ON c.sale_id = s.id
         JOIN cases ca       ON ca.id = s.case_id
         LEFT JOIN catalogue cat ON cat.id = ca.selected_plan_id
        WHERE c.issued_snapshot IS NOT NULL${LIVE_ONLY}
          AND (
                COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.issued_snapshot, '$.trip.destination')), '')
                  <> COALESCE(ca.destination, '')
             OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.issued_snapshot, '$.plan.name')), '')
                  <> COALESCE(cat.name, '')
             OR LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.issued_snapshot, '$.trip.start_date')), ''), 10)
                  <> DATE_FORMAT(ca.start_date, '%Y-%m-%d')
             OR LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.issued_snapshot, '$.trip.end_date')), ''), 10)
                  <> DATE_FORMAT(ca.end_date, '%Y-%m-%d')
          )
        ORDER BY s.id ASC`
    );
    return rows;
  }
  if (EDITED) {
    const [rows] = await pool.query(
      `SELECT s.id AS sale_id, s.case_id
         FROM sales s
         JOIN certificates c ON c.sale_id = s.id
        WHERE COALESCE(s.policy_edit_count, 0) > 0${LIVE_ONLY}
        ORDER BY s.id ASC`
    );
    return rows;
  }
  return usage("say which policies: --drifted, --edited, --sale=, --case= or --id=");
}

async function main() {
  initializePool(process.env);
  const pool = getPool();
  const rows = await targets(pool);
  console.log(`[snapshots] ${rows.length} policy(ies) selected${DRY ? " — dry run, nothing will be written" : ""}`);

  if (rows.length === 0) {
    if (saleArg || caseArg || idArg) {
      console.log("[snapshots] nothing matched. That id may belong to the other table.");
      console.log("[snapshots] try --id=<n>, which checks both, or --drifted to list every stale certificate.");
    } else if (EDITED) {
      console.log("[snapshots] note: --edited only sees OPERATOR-role edits. An admin correction does not increment that counter.");
      console.log("[snapshots] use --drifted instead — it compares each snapshot against its case.");
    } else if (DRIFTED) {
      console.log("[snapshots] no certificate disagrees with its case. Nothing to refresh.");
    }
  }

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
