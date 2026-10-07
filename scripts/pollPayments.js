#!/usr/bin/env node
// scripts/pollPayments.js
//
// Ask the provider before giving up on a payment.
//
// A callback can be lost: a provider outage, a DNS blip, a deploy restarting
// the process mid-request. The sweeper would then expire a payment the customer
// actually made — taking their money and issuing nothing, which is the worst
// outcome this system can produce.
//
// So this runs FIRST and more often than the sweeper: for every transaction
// still waiting, it asks the provider what really happened and settles the ones
// that have an answer. The sweeper only ever sees the genuinely abandoned.
//
//   */2 * * * * cd /path/to/backend && /usr/bin/node scripts/pollPayments.js >> /var/log/aas-poll.log 2>&1
//
//   --dry-run     report, settle nothing
//   --limit=N     cap one pass (default 50)
//   --min-age=N   only poll transactions older than N seconds (default 60)
//
import dotenv from "dotenv";
import { initializePool, getPool } from "../utils/db.js";
import { findPending, setProviderTxId } from "../models/paymentModel.js";
import { getProvider } from "../utils/payments/index.js";
import { getProviderConfig } from "../utils/payments/config.js";
import { normaliseResult } from "../utils/payments/provider.js";
import { settlePayment } from "../utils/payments/service.js";

dotenv.config();

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const num = (flag, fallback) => {
  const a = args.find((x) => x.startsWith(`--${flag}=`));
  return a ? Number(a.split("=")[1]) || fallback : fallback;
};
const LIMIT = num("limit", 50);
const MIN_AGE_SECONDS = num("min-age", 60);

async function main() {
  initializePool(process.env);

  const pending = await findPending(LIMIT);
  const due = pending.filter(
    (tx) => Date.now() - new Date(tx.updated_at || tx.created_at).getTime() > MIN_AGE_SECONDS * 1000
  );

  if (due.length === 0) {
    console.log("[poll] nothing waiting long enough to ask about");
    return 0;
  }
  console.log(`[poll] asking the provider about ${due.length} transaction(s)${dryRun ? " (dry run)" : ""}`);

  let settled = 0;
  let stillWaiting = 0;

  for (const tx of due) {
    const provider = getProvider(tx.provider);
    const config = await getProviderConfig(tx.provider);
    if (!provider || !config?.ready) {
      console.log(`[poll] ${tx.reference}: ${tx.provider} is not configured, skipping`);
      continue;
    }

    let result;
    try {
      result = normaliseResult(
        await provider.checkStatus({
          providerTxId: tx.provider_tx_id,
          reference: tx.reference,
          msisdn: tx.msisdn,
          config,
        }),
        tx.provider
      );
    } catch (err) {
      console.error(`[poll] ${tx.reference}: ${err.message}`);
      continue;
    }

    // The provider may hand us its id for the first time here — an initiation
    // whose response was lost still has one on their side.
    if (result.providerTxId && !tx.provider_tx_id) {
      await setProviderTxId(tx.id, result.providerTxId).catch(() => {});
    }

    const terminal = ["completed", "failed", "expired", "cancelled"].includes(result.status);
    if (!terminal) {
      stillWaiting += 1;
      continue;
    }

    if (dryRun) {
      console.log(`[poll] would settle ${tx.reference} as ${result.status}`);
      settled += 1;
      continue;
    }

    // settlePayment issues the policy, tells the customer and sends the
    // certificate — the same path a callback takes, so a lost callback and a
    // delivered one end in exactly the same place.
    const outcome = await settlePayment({
      transactionId: tx.id,
      status: result.status,
      failureCode: result.failureCode || null,
    });
    settled += 1;
    console.log(
      `[poll] ${tx.reference} settled as ${result.status}` +
        (outcome.policyNumber ? ` → policy ${outcome.policyNumber}` : "")
    );
  }

  console.log(`[poll] settled ${settled}, still waiting ${stillWaiting}`);
  return 0;
}

main()
  .then(async (code) => {
    await getPool().end().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("[poll] failed:", err.message);
    await getPool().end().catch(() => {});
    process.exit(1);
  });
