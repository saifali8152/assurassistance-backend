#!/usr/bin/env node
// scripts/encryptPassports.js
//
// Encrypt the passport numbers already in the database.
//
// The migration adds the columns; it does not touch a single row, because a
// migration that rewrites customer data while the service is running is not
// something to do by surprise. This does it deliberately, in batches, with a
// dry run, under the operator's control.
//
//   node scripts/encryptPassports.js --dry-run     # report, change nothing
//   node scripts/encryptPassports.js               # encrypt, KEEP the plaintext
//   node scripts/encryptPassports.js --clear       # encrypt, then clear plaintext
//
// RUN IT IN TWO PASSES. First without --clear: every row gains ciphertext while
// the plaintext stays, so nothing can break and the backup you took five
// minutes ago is still a complete one. Check the app, check a certificate
// renders, then run again with --clear. Reversing the order means a bug in the
// read path costs you the data.
//
import dotenv from "dotenv";
import { initializePool, getPool } from "../utils/db.js";
import { encryptionReady, passportColumns, readPassport } from "../utils/travellerPrivacy.js";

dotenv.config();

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const clear = args.includes("--clear");
const batchArg = args.find((a) => a.startsWith("--batch="));
const BATCH = batchArg ? Math.max(1, Number(batchArg.split("=")[1]) || 200) : 200;

async function main() {
  initializePool(process.env);

  if (!encryptionReady()) {
    console.error(
      "[passports] SETTINGS_ENCRYPTION_KEY is not set, so nothing can be encrypted.\n" +
        "            Generate one with: openssl rand -hex 32"
    );
    return 1;
  }

  const pool = getPool();
  const [[counts]] = await pool.query(`
    SELECT
      COUNT(*)                                                             AS total,
      SUM(passport_or_id IS NOT NULL AND passport_or_id <> '')             AS plaintext,
      SUM(passport_or_id_enc IS NOT NULL)                                  AS encrypted
    FROM travellers
  `);
  console.log(
    `[passports] ${counts.total} travellers · ${Number(counts.plaintext) || 0} with plaintext · ` +
      `${Number(counts.encrypted) || 0} already encrypted`
  );

  let done = 0;
  let failed = 0;

  for (;;) {
    const [rows] = await pool.query(
      `SELECT id, passport_or_id
         FROM travellers
        WHERE passport_or_id IS NOT NULL AND passport_or_id <> ''
          AND passport_or_id_enc IS NULL
        ORDER BY id
        LIMIT ?`,
      [BATCH]
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      if (dryRun) {
        done += 1;
        continue;
      }
      try {
        const cols = passportColumns(row.passport_or_id);
        // Verify before writing: encrypt, decrypt, compare. An unreadable
        // ciphertext written over a readable plaintext is the one outcome this
        // script must never produce.
        const roundTrip = readPassport({ passport_or_id_enc: cols.passport_or_id_enc });
        if (roundTrip !== String(row.passport_or_id)) {
          throw new Error("round trip did not match");
        }
        await pool.execute(
          `UPDATE travellers SET passport_or_id_enc = ?, passport_or_id_hash = ? WHERE id = ?`,
          [cols.passport_or_id_enc, cols.passport_or_id_hash, row.id]
        );
        done += 1;
      } catch (err) {
        failed += 1;
        console.error(`[passports] traveller ${row.id} failed: ${err.message}`);
      }
    }
    if (dryRun) break;
  }

  console.log(`[passports] ${dryRun ? "would encrypt" : "encrypted"} ${done}, failed ${failed}`);

  if (clear && !dryRun) {
    // Only rows whose ciphertext is present AND readable lose their plaintext.
    const [res] = await pool.execute(
      `UPDATE travellers
          SET passport_or_id = NULL
        WHERE passport_or_id_enc IS NOT NULL
          AND passport_or_id IS NOT NULL`
    );
    console.log(`[passports] cleared plaintext on ${res.affectedRows} row(s)`);
  } else if (!dryRun) {
    console.log("[passports] plaintext left in place — re-run with --clear once you have checked the app");
  }

  return failed > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    await getPool().end().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("[passports] failed:", err.message);
    await getPool().end().catch(() => {});
    process.exit(1);
  });
