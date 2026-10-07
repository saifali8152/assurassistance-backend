#!/usr/bin/env node
// scripts/dailySummary.js
//
// The daily transaction summary for the client.
//
// WHY IT EXISTS: the client has no way to see yesterday without logging in and
// reading three screens, and nobody reads three screens every morning. One
// email with the figures that matter — and, more usefully, a short list of
// things that need a human — is the difference between noticing a stuck payment
// today and noticing it at month end.
//
// Cron, once a day, after midnight in the client's own timezone:
//
//   10 6 * * * cd /path/to/backend && /usr/bin/node scripts/dailySummary.js >> /var/log/aas-summary.log 2>&1
//
//   --date=YYYY-MM-DD   a specific day (default: yesterday)
//   --dry-run           print it instead of sending
//   --to=a@b.c          override the recipients
//
import dotenv from "dotenv";
import { initializePool, getPool } from "../utils/db.js";
import { dailyActivity } from "../models/reportingModel.js";
import sendEmail from "../utils/emailService.js";

dotenv.config();

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dateArg = args.find((a) => a.startsWith("--date="));
const toArg = args.find((a) => a.startsWith("--to="));

/** Yesterday in the server's own timezone — which is the day the client means. */
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const money = (n, currency = "XOF") =>
  `${new Intl.NumberFormat("fr-FR").format(Math.round(Number(n) || 0))} ${currency}`;

function render(report) {
  const lines = [];
  lines.push(`Assur'Assistance — ${report.day}`);
  lines.push("");
  lines.push("POLICIES");
  lines.push(`  Issued:        ${report.policies.issued}`);
  lines.push(`  Value:         ${money(report.policies.totalValue)}`);
  lines.push(`  Collected:     ${money(report.policies.paidValue)}`);
  lines.push(`  Paid / unpaid: ${report.policies.paid} / ${report.policies.unpaid}`);

  lines.push("");
  lines.push("PAYMENTS");
  if (report.payments.length === 0) {
    lines.push("  No payment attempts.");
  } else {
    for (const p of report.payments) {
      lines.push(`  ${p.status.padEnd(22)} ${p.provider.padEnd(8)} ${String(p.count).padStart(4)}   ${money(p.amount)}`);
    }
  }

  if (report.failures.length) {
    lines.push("");
    lines.push("WHY PAYMENTS FAILED");
    for (const f of report.failures) lines.push(`  ${String(f.count).padStart(4)}  ${f.code}`);
  }

  lines.push("");
  lines.push("WHATSAPP");
  lines.push(`  Conversations: ${report.conversations.started}`);
  lines.push(`  Completed:     ${report.conversations.completed}`);
  lines.push(`  Escalated:     ${report.conversations.escalated}`);

  const a = report.attention;
  const needsHuman = a.stuckPayments + a.unmatchedCallbacks + a.paidWithoutPolicy;
  lines.push("");
  lines.push(needsHuman ? "NEEDS ATTENTION" : "NOTHING NEEDS ATTENTION");
  if (a.stuckPayments) lines.push(`  ${a.stuckPayments} payment(s) past their window and not settled`);
  if (a.unmatchedCallbacks) lines.push(`  ${a.unmatchedCallbacks} provider callback(s) matched no transaction`);
  // The one line worth waking someone for: money taken, nothing issued.
  if (a.paidWithoutPolicy) lines.push(`  ${a.paidWithoutPolicy} PAID payment(s) with no policy issued — check these first`);

  return lines.join("\n");
}

function recipients() {
  if (toArg) return toArg.split("=")[1];
  return process.env.SUMMARY_EMAIL || process.env.ALERT_EMAIL || "";
}

async function main() {
  initializePool(process.env);
  const day = dateArg ? dateArg.split("=")[1] : yesterday();
  const report = await dailyActivity(day);
  const text = render(report);

  if (dryRun) {
    console.log(text);
    return 0;
  }

  const to = recipients();
  if (!to) {
    console.error("[summary] no SUMMARY_EMAIL or ALERT_EMAIL configured — nothing sent");
    console.log(text);
    return 1;
  }

  const flag = report.attention.paidWithoutPolicy > 0 ? " — ACTION NEEDED" : "";
  await sendEmail(to, `Assur'Assistance daily summary ${day}${flag}`, text, null);
  console.log(`[summary] sent ${day} to ${to}`);
  return 0;
}

main()
  .then(async (code) => {
    await getPool().end().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("[summary] failed:", err.message);
    await getPool().end().catch(() => {});
    process.exit(1);
  });
