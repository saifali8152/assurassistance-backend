/**
 * Seed Agico Retail / Road Travel Burundi plans (duration premiums + fixed_duration_premiums flag).
 *
 * Usage (on the VPS, from the backend folder):
 *   node scripts/seedAgicoBurundiPlans.js
 *
 * Safe to re-run: updates existing plans by name, or inserts if missing.
 */
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });

  try {
    const [cols] = await conn.query(
      "SHOW COLUMNS FROM catalogue LIKE 'fixed_duration_premiums'"
    );
    if (!cols.length) {
      await conn.query(
        "ALTER TABLE catalogue ADD COLUMN fixed_duration_premiums TINYINT(1) NOT NULL DEFAULT 0 AFTER extra_id_fields"
      );
      console.log("Added column catalogue.fixed_duration_premiums");
    }

    const sqlPath = path.join(__dirname, "..", "migrations", "seed_agico_burundi_plans.sql");
    const sql = fs.readFileSync(sqlPath, "utf8");
    await conn.query(sql);

    const [rows] = await conn.query(
      `SELECT id, name, product_type, currency, active, fixed_duration_premiums,
              JSON_LENGTH(pricing_rules, '$.pricing') AS pricing_rows,
              JSON_EXTRACT(pricing_rules, '$.pricing[0].columns') AS sample_10_days
       FROM catalogue
       WHERE name IN (
         'Agico Retail Burundi', 'AGICO Retail Burundi',
         'Agico Road Travel Burundi', 'AGICO Road Travel Burundi'
       )
       ORDER BY id`
    );

    console.log("Agico Burundi plans:");
    console.table(rows);
    console.log("Done.");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
