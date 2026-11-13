// tests/i18nParity.test.mjs
//
// French and English must say the same things. A key present in one language
// and missing in the other means a customer silently gets the other language
// (or a raw key) in the middle of a conversation.
//
// Also checks the hard limits WhatsApp puts on interactive messages, for every
// string that is used as a button title or a list row.
//
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (lang) => JSON.parse(fs.readFileSync(path.join(here, "..", "i18n", `${lang}.json`), "utf8"));
const FR = load("fr");
const EN = load("en");

function flatten(obj, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

const fr = flatten(FR);
const en = flatten(EN);

test("every French key exists in English and vice versa", () => {
  const missingEn = Object.keys(fr).filter((k) => !(k in en));
  const missingFr = Object.keys(en).filter((k) => !(k in fr));
  assert.deepEqual(missingEn, [], `missing in en.json: ${missingEn.join(", ")}`);
  assert.deepEqual(missingFr, [], `missing in fr.json: ${missingFr.join(", ")}`);
});

test("no string is empty", () => {
  for (const [k, v] of [...Object.entries(fr), ...Object.entries(en)]) {
    assert.ok(typeof v === "string" && v.trim().length > 0, `empty: ${k}`);
  }
});

test("both languages use the same placeholders in each string", () => {
  const vars = (s) => [...String(s).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
  for (const k of Object.keys(fr)) {
    if (!(k in en)) continue;
    assert.deepEqual(vars(fr[k]), vars(en[k]), `placeholders differ in ${k}`);
  }
});

// WhatsApp: reply-button titles ≤ 20 characters, list row titles ≤ 24, row
// descriptions ≤ 72, the list's button text ≤ 20.
const BUTTON_TITLES = [
  "claim.switchYes", "claim.switchNo", "claim.resumeYes", "claim.resumeNo", "claim.buyButton", "claim.agentButton",
  "claim.policyYes", "claim.policyNo", "claim.skipButton", "claim.documentsDoneButton", "claim.documentsLaterButton",
  "claim.reviewSubmit", "claim.reviewModify", "claim.reviewCancel", "claim.consentAccept", "claim.consentDecline",
  "claim.listButton", "welcome.menuButton",
];
const ROW_TITLES = [
  "welcome.optionBuy", "welcome.optionClaim", "welcome.optionTrack", "welcome.optionQuestion", "welcome.optionAgent",
  "claim.editType", "claim.editDate", "claim.editPlace", "claim.editDetails", "claim.editDescription", "claim.editDocuments",
];
const ROW_DESCRIPTIONS = ["welcome.hintBuy", "welcome.hintClaim", "welcome.hintTrack", "welcome.hintQuestion", "welcome.hintAgent"];

test("claim button and list labels fit WhatsApp's limits in both languages", () => {
  for (const [table, name] of [[fr, "fr"], [en, "en"]]) {
    for (const k of BUTTON_TITLES) assert.ok(table[k] && table[k].length <= 20, `${name} ${k} (${table[k]?.length}) > 20`);
    for (const k of ROW_TITLES) assert.ok(table[k] && table[k].length <= 24, `${name} ${k} (${table[k]?.length}) > 24`);
    for (const k of ROW_DESCRIPTIONS) assert.ok(table[k] && table[k].length <= 72, `${name} ${k} (${table[k]?.length}) > 72`);
  }
});

test("every claim status the admin can set has a customer-facing name", () => {
  for (const s of ["draft", "submitted", "under_review", "closed", "abandoned"]) {
    assert.ok(fr[`claim.status.${s}`] && en[`claim.status.${s}`], s);
  }
});
