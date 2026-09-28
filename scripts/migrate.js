#!/usr/bin/env node
/**
 * Milestone 2 migration runner.
 *
 * WHY THIS EXISTS
 *   Historically the .sql files in migrations/ were applied by hand, in an order
 *   that only the developer who wrote them knew. With the WhatsApp module adding
 *   eight more files that must reach a LIVE database, guessing is not acceptable.
 *   This runner keeps a ledger (`schema_migrations`) so every file is applied at
 *   most once, in a deterministic order, and a re-run is a safe no-op.
 *
 * SAFETY GUARANTEES
 *   * It only ever executes files it has not recorded as applied.
 *   * It refuses to run if a previously applied file's contents have changed
 *     (checksum mismatch) — that is a sign of an edited migration, which on a
 *     live database is how data gets lost. Use --force-checksum to acknowledge.
 *   * It never drops, truncates or deletes anything itself; the migrations it
 *     runs are additive by policy (see docs/WHATSAPP_MODULE_PLAN.md).
 *   * Legacy (pre-Milestone-2) files are NOT executed by default, because they
 *     are already present on the live database. Use --baseline once to record
 *     them as such, or --include-legacy on a brand-new empty database.
 *
 * USAGE
 *   node scripts/migrate.js --status            show applied / pending
 *   node scripts/migrate.js --dry-run           print what would run, change nothing
 *   node scripts/migrate.js --baseline          mark legacy files as already present
 *   node scripts/migrate.js                     apply pending Milestone-2 files
 *   node scripts/migrate.js --include-legacy    fresh database: apply everything
 *
 * Environment: reads the same DB_* variables as the app (.env).
 */
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

/** Milestone-2 and later files use this prefix and are safe for the runner. */
const MANAGED_PREFIX = /^m\d+_\d+_/;

const args = new Set(process.argv.slice(2));
const OPT = {
  status: args.has("--status"),
  dryRun: args.has("--dry-run"),
  baseline: args.has("--baseline"),
  includeLegacy: args.has("--include-legacy"),
  forceChecksum: args.has("--force-checksum"),
};

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS \`schema_migrations\` (
  \`id\` INT NOT NULL AUTO_INCREMENT,
  \`filename\` VARCHAR(255) NOT NULL,
  \`checksum\` CHAR(64) NOT NULL,
  \`state\` ENUM('applied','baseline') NOT NULL DEFAULT 'applied',
  \`applied_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`execution_ms\` INT UNSIGNED NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_schema_migrations_filename\` (\`filename\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function listFiles() {
  const all = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));
  return {
    managed: all.filter((f) => MANAGED_PREFIX.test(f)),
    legacy: all.filter((f) => !MANAGED_PREFIX.test(f)),
  };
}

function requireDbConfig() {
  const missing = ["DB_HOST", "DB_USER", "DB_NAME"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`✖ Missing environment variables: ${missing.join(", ")}`);
    console.error("  Copy .env.example to .env and fill in the database section.");
    process.exit(1);
  }
}

async function connect() {
  requireDbConfig();
  return mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    // The guarded ALTER migrations use SET / PREPARE / EXECUTE blocks.
    multipleStatements: true,
  });
}

async function readLedger(conn) {
  const [rows] = await conn.query(
    "SELECT filename, checksum, state, applied_at FROM `schema_migrations`"
  );
  return new Map(rows.map((r) => [r.filename, r]));
}

async function applyFile(conn, filename, sql, checksum) {
  const startedAt = Date.now();
  await conn.query(sql);
  const elapsed = Date.now() - startedAt;
  await conn.execute(
    "INSERT INTO `schema_migrations` (filename, checksum, state, execution_ms) VALUES (?, ?, 'applied', ?)",
    [filename, checksum, elapsed]
  );
  return elapsed;
}

async function main() {
  const { managed, legacy } = listFiles();
  const conn = await connect();

  try {
    await conn.query(LEDGER_DDL);
    const ledger = await readLedger(conn);

    // ---- Checksum drift check on already-applied files -----------------------
    const drifted = [];
    for (const [filename, row] of ledger) {
      const full = path.join(MIGRATIONS_DIR, filename);
      if (!fs.existsSync(full)) continue;
      if (row.state === "baseline") continue;
      const current = sha256(fs.readFileSync(full, "utf8"));
      if (current !== row.checksum) drifted.push(filename);
    }
    if (drifted.length && !OPT.forceChecksum && !OPT.status) {
      console.error("✖ These applied migrations have been edited since they ran:");
      drifted.forEach((f) => console.error(`    ${f}`));
      console.error("  Editing an applied migration will not re-run it. Add a NEW");
      console.error("  migration instead, or pass --force-checksum to acknowledge.");
      process.exit(1);
    }

    // ---- Status -------------------------------------------------------------
    if (OPT.status) {
      const line = (f) => {
        const row = ledger.get(f);
        if (!row) return `  pending   ${f}`;
        const when = new Date(row.applied_at).toISOString().slice(0, 19).replace("T", " ");
        return `  ${row.state === "baseline" ? "baseline " : "applied  "} ${f}   (${when})`;
      };
      console.log(`\nDatabase: ${process.env.DB_NAME}@${process.env.DB_HOST}\n`);
      console.log("Legacy (applied manually before Milestone 2):");
      legacy.forEach((f) => console.log(line(f)));
      console.log("\nManaged by this runner:");
      managed.forEach((f) => console.log(line(f)));
      const pending = managed.filter((f) => !ledger.has(f));
      console.log(`\n${pending.length} pending.\n`);
      return;
    }

    // ---- Baseline -----------------------------------------------------------
    if (OPT.baseline) {
      let recorded = 0;
      for (const f of legacy) {
        if (ledger.has(f)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
        if (OPT.dryRun) {
          console.log(`  would baseline  ${f}`);
        } else {
          await conn.execute(
            "INSERT INTO `schema_migrations` (filename, checksum, state) VALUES (?, ?, 'baseline')",
            [f, sha256(sql)]
          );
          console.log(`  baselined  ${f}`);
        }
        recorded += 1;
      }
      console.log(`\n${recorded} legacy migration(s) recorded as already present. Nothing was executed.\n`);
      return;
    }

    // ---- Apply --------------------------------------------------------------
    const queue = OPT.includeLegacy ? [...legacy, ...managed] : managed;
    const pending = queue.filter((f) => !ledger.has(f));

    if (pending.length === 0) {
      console.log("\n✔ Database is up to date. Nothing to apply.\n");
      return;
    }

    console.log(`\nDatabase: ${process.env.DB_NAME}@${process.env.DB_HOST}`);
    console.log(`${pending.length} migration(s) to apply:\n`);

    for (const f of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      if (OPT.dryRun) {
        console.log(`  would apply  ${f}`);
        continue;
      }
      try {
        const ms = await applyFile(conn, f, sql, sha256(sql));
        console.log(`  ✔ ${f}  (${ms}ms)`);
      } catch (err) {
        console.error(`  ✖ ${f}`);
        console.error(`    ${err.code || ""} ${err.sqlMessage || err.message}`);
        console.error("\n  Stopped. Earlier migrations stay applied and recorded;");
        console.error("  fix this file and run the command again.\n");
        process.exit(1);
      }
    }

    console.log(OPT.dryRun ? "\nDry run complete. Nothing was changed.\n" : "\n✔ All migrations applied.\n");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("✖ Migration runner failed:", err.message);
  process.exit(1);
});
