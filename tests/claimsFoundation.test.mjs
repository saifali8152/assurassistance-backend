// tests/claimsFoundation.test.mjs
//
// Milestone 4, Day 1 — the pieces everything else stands on: the claim state
// machine, the seeded categories, the editor's validation and the claims
// settings. No database: these are the rules, tested as rules.
//
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { CLAIM_STATUSES, CLAIM_TRANSITIONS, canTransition, isTerminal } from "../utils/claims/stateMachine.js";
import { DEFAULT_CATEGORIES, NAME_MAX, HINT_MAX, MAX_SUBCATEGORIES_PER_CATEGORY } from "../utils/claims/defaultCategories.js";
import { validateCategoryInput, mapCategory } from "../models/claimCategoryModel.js";
import { SETTING_REGISTRY, validateSettingValue } from "../models/settingsModel.js";
import { validateEmailList, validatePattern, validateKeywordList, parseEmailList } from "../utils/claims/settingsValidators.js";
import { normaliseNumber, maskNumber } from "../utils/featureFlags.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.join(here, "..", "migrations");

/* ----------------------------------------------------------- state machine */

test("exactly the documented transitions are legal, every other pair is refused", () => {
  const legal = new Set([
    "draft>submitted", "draft>abandoned",
    "submitted>under_review", "submitted>closed",
    "under_review>closed",
  ]);
  for (const from of CLAIM_STATUSES) {
    for (const to of CLAIM_STATUSES) {
      assert.equal(canTransition(from, to), legal.has(`${from}>${to}`), `${from} → ${to}`);
    }
  }
});

test("closed and abandoned are terminal; nothing leads back to draft", () => {
  assert.equal(isTerminal("closed"), true);
  assert.equal(isTerminal("abandoned"), true);
  assert.equal(isTerminal("submitted"), false);
  for (const targets of Object.values(CLAIM_TRANSITIONS)) assert.ok(!targets.includes("draft"));
});

test("an unknown status can go nowhere", () => {
  assert.equal(canTransition("paid", "closed"), false);
  assert.equal(canTransition(undefined, "submitted"), false);
});

/* -------------------------------------------------------------- the seed */

test("the seed is the client's list: 4 categories, 17 sub-categories", () => {
  const parents = DEFAULT_CATEGORIES.filter((c) => !c.parent_code);
  const subs = DEFAULT_CATEGORIES.filter((c) => c.parent_code);
  assert.deepEqual(parents.map((p) => p.code), ["travel", "medical", "accident", "legal"]);
  assert.equal(subs.length, 17);
  const count = (p) => subs.filter((s) => s.parent_code === p).length;
  assert.deepEqual([count("travel"), count("medical"), count("accident"), count("legal")], [6, 4, 3, 4]);
});

test("every name and hint fits WhatsApp's list limits", () => {
  for (const c of DEFAULT_CATEGORIES) {
    assert.ok(c.name_fr.length <= NAME_MAX, `${c.code} name_fr`);
    assert.ok(c.name_en.length <= NAME_MAX, `${c.code} name_en`);
    assert.ok(c.hint_fr.length <= HINT_MAX, `${c.code} hint_fr`);
    assert.ok(c.hint_en.length <= HINT_MAX, `${c.code} hint_en`);
  }
});

test("every seeded category passes the same validation the admin editor applies", () => {
  // If the shipped data would be refused by the editor, the client could never
  // save an unchanged category — so the seed is held to the editor's rules.
  const all = [];
  for (const c of DEFAULT_CATEGORIES) {
    const r = validateCategoryInput(c, { all: all.map(mapCategory) });
    assert.equal(r.ok, true, `${c.code}: ${JSON.stringify(r.errors)}`);
    all.push({ ...c, id: all.length + 1, active: 1 });
  }
});

test("the plan's example fields are where the plan says they are", () => {
  const byCode = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.code, c]));
  assert.ok(byCode.flight_delay.extra_fields.some((f) => f.key === "flight_number"));
  assert.ok(byCode.hospitalization.extra_fields.some((f) => f.key === "hospital_name"));
  assert.ok(byCode.flight_delay.required_documents.some((d) => d.code === "boarding_pass"));
  assert.ok(byCode.flight_delay.required_documents.some((d) => d.code === "delay_certificate"));
  assert.equal(byCode.hospitalization.default_priority, "urgent");
  assert.equal(byCode.medical_repatriation.default_priority, "urgent");
});

/* ---------------------------------------------------- the category editor */

const ALL = DEFAULT_CATEGORIES.map((c, i) => mapCategory({ ...c, id: i + 1, active: 1,
  required_documents: c.required_documents, optional_documents: c.optional_documents,
  extra_fields: c.extra_fields, guarantee_codes: c.guarantee_codes }));

test("a name longer than WhatsApp shows is refused with the reason", () => {
  const r = validateCategoryInput({ code: "x_long", parent_code: "travel", name_fr: "A".repeat(25), name_en: "Ok" }, { all: ALL });
  assert.equal(r.ok, false);
  assert.match(r.errors.name_fr, /24/);
});

test("codes are validated and must be unique", () => {
  assert.equal(validateCategoryInput({ code: "Bad Code", parent_code: "travel", name_fr: "a", name_en: "a" }, { all: ALL }).ok, false);
  const dup = validateCategoryInput({ code: "flight_delay", parent_code: "travel", name_fr: "a", name_en: "a" }, { all: ALL });
  assert.match(dup.errors.code, /already exists/);
});

test("a sub-category must sit under a top-level category", () => {
  const r = validateCategoryInput({ code: "x_child", parent_code: "flight_delay", name_fr: "a", name_en: "a" }, { all: ALL });
  assert.match(r.errors.parent_code, /top-level/);
});

test("a category cannot hold more rows than a WhatsApp list", () => {
  const crowded = [...ALL];
  for (let i = 0; i < MAX_SUBCATEGORIES_PER_CATEGORY; i += 1) {
    crowded.push(mapCategory({ code: `pad_${i}`, parent_code: "legal", name_fr: "p", name_en: "p", active: 1 }));
  }
  const r = validateCategoryInput({ code: "one_more", parent_code: "legal", name_fr: "a", name_en: "a" }, { all: crowded });
  assert.match(r.errors.parent_code, /10/);
});

test("a document cannot be both required and optional", () => {
  const d = { code: "same", label_fr: "x", label_en: "x" };
  const r = validateCategoryInput(
    { code: "x_docs", parent_code: "travel", name_fr: "a", name_en: "a", required_documents: [d], optional_documents: [d] },
    { all: ALL }
  );
  assert.match(r.errors.optional_documents, /both required and optional/);
});

test("extra fields are checked: type, labels, prompts, choice options", () => {
  const base = { code: "x_fields", parent_code: "travel", name_fr: "a", name_en: "a" };
  const field = { key: "kk", type: "text", label_fr: "l", label_en: "l", prompt_fr: "p", prompt_en: "p" };
  assert.equal(validateCategoryInput({ ...base, extra_fields: [field] }, { all: ALL }).ok, true);
  assert.equal(validateCategoryInput({ ...base, extra_fields: [{ ...field, type: "file" }] }, { all: ALL }).ok, false);
  assert.equal(validateCategoryInput({ ...base, extra_fields: [{ ...field, prompt_en: "" }] }, { all: ALL }).ok, false);
  assert.equal(validateCategoryInput({ ...base, extra_fields: [{ ...field, type: "choice", options: [{ value: "a", label_fr: "a", label_en: "a" }] }] }, { all: ALL }).ok, false);
  assert.equal(validateCategoryInput({ ...base, extra_fields: [field, field] }, { all: ALL }).ok, false, "duplicate keys");
});

test("editing keeps the code and parent of the row it edits", () => {
  const existing = ALL.find((c) => c.code === "flight_delay");
  const r = validateCategoryInput({ code: "hijack", parent_code: "legal", name_fr: "Retard" }, { existing, all: ALL });
  assert.equal(r.ok, true);
  assert.equal(r.value.code, "flight_delay");
  assert.equal(r.value.parent_code, "travel");
  assert.equal(r.value.name_fr, "Retard");
  assert.equal(r.value.name_en, "Flight delay", "untouched fields keep their value");
});

/* --------------------------------------------------------------- settings */

test("every claims rule the client controls is a registered setting with a safe default", () => {
  const keys = Object.keys(SETTING_REGISTRY).filter((k) => k.startsWith("claims."));
  assert.equal(keys.length, 23);
  const d = (k) => SETTING_REGISTRY[k].default;
  assert.equal(d("claims.expiry_rule"), "incident_date", "expiry judged at the incident date by default");
  assert.equal(d("claims.unpaid_policies"), "allow_flag");
  assert.equal(d("claims.uncovered_claim_type"), "flag");
  assert.equal(d("claims.card_number_mode"), "certificate");
  assert.equal(d("claims.consent_text_fr"), undefined, "consent is empty until the client writes it");
});

test("claims settings are validated before they are saved", () => {
  assert.equal(validateSettingValue("claims.number_format", "SIN-{YYYY}-{SEQ:6}").ok, true);
  assert.equal(validateSettingValue("claims.number_format", "no sequence").ok, false);
  assert.equal(validateSettingValue("claims.expiry_rule", "yesterday").ok, false);
  assert.equal(validateSettingValue("claims.max_file_mb", 500).ok, false);
  assert.equal(validateSettingValue("claims.notification_emails", "claims@insurer.ci, ops@insurer.ci").ok, true);
  assert.equal(validateSettingValue("claims.notification_emails", "not-an-email").ok, false);
});

test("a card-number pattern that could hang the server is refused", () => {
  assert.equal(validatePattern("^AA[0-9]{8}$").ok, true);
  assert.equal(validatePattern("(a+)+$").ok, false);
  assert.equal(validatePattern("([0-9]*)*").ok, false);
  assert.equal(validatePattern("[unclosed").ok, false);
  assert.equal(validatePattern("x".repeat(201)).ok, false);
});

test("email and keyword lists parse the way they validate", () => {
  assert.deepEqual(parseEmailList("a@b.co; c@d.org  e@f.net"), ["a@b.co", "c@d.org", "e@f.net"]);
  assert.equal(validateEmailList(Array.from({ length: 11 }, (_, i) => `a${i}@b.co`).join(",")).ok, false);
  assert.equal(validateKeywordList("urgence, hôpital").ok, true);
  assert.equal(validateKeywordList("x".repeat(61)).ok, false);
});

/* ------------------------------------------------------------ the numbers */

test("allowlist numbers are compared as digits, and masked when shown", () => {
  assert.equal(normaliseNumber("+225 07 18-92 31 94"), "2250718923194");
  assert.equal(maskNumber("2250718923194"), "••••••3194");
  assert.equal(maskNumber("12"), "••••");
});

/* -------------------------------------------- generated migrations in step */

test("the generated migrations carry every category and every setting", () => {
  const cats = fs.readFileSync(path.join(migrations, "m4_03_claim_categories.sql"), "utf8");
  for (const c of DEFAULT_CATEGORIES) assert.ok(cats.includes(`('${c.code}',`), `seed is missing ${c.code}`);
  const sets = fs.readFileSync(path.join(migrations, "m4_08_claim_settings.sql"), "utf8");
  for (const k of Object.keys(SETTING_REGISTRY).filter((x) => x.startsWith("claims."))) {
    assert.ok(sets.includes(`('${k}',`), `settings seed is missing ${k}`);
  }
});

test("every Milestone 4 migration is additive", () => {
  const files = fs.readdirSync(migrations).filter((f) => /^m4_\d+_/.test(f));
  assert.equal(files.length, 8);
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrations, f), "utf8").replace(/--.*$/gm, "");
    assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|INDEX|KEY)\b/i, `${f} drops something`);
    assert.doesNotMatch(sql, /\bTRUNCATE\b/i, `${f} truncates`);
    assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i, `${f} deletes rows`);
    assert.doesNotMatch(sql, /\bMODIFY\s+COLUMN\b/i, `${f} modifies a column`);
    assert.doesNotMatch(sql, /\bUPDATE\s+`?(sales|cases|travellers|certificates|invoices)`?\b/i, `${f} writes to live data`);
    assert.doesNotMatch(sql, /REFERENCES\s+`?(sales|cases|travellers|certificates|users)`?/i, `${f} adds a foreign key onto a live table`);
  }
});
