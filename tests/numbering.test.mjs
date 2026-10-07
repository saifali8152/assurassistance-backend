// tests/numbering.test.mjs
//
// Document numbering used to be `POL-${Date.now()}`. These tests pin the two
// properties that replaced it: a format renders exactly as the operator wrote
// it, and a format that could produce colliding numbers is rejected before it
// can be saved.
//
import test from "node:test";
import assert from "node:assert/strict";

import {
  renderFormat,
  periodFor,
  validateFormat,
} from "../utils/documentNumbers.js";

const OCT_2026 = new Date(2026, 9, 6); // 6 October 2026, local time

/* --------------------------------------------------------------- rendering */

test("renders the seeded default format", () => {
  assert.equal(renderFormat("AA-{YYYY}-{SEQ:6}", 42, OCT_2026), "AA-2026-000042");
});

test("supports two-digit year and month tokens", () => {
  assert.equal(renderFormat("POL/{YY}{MM}/{SEQ:4}", 7, OCT_2026), "POL/2610/0007");
});

test("a sequence wider than its padding keeps counting rather than wrapping", () => {
  // A wider number is ugly; a wrapped one is a duplicate policy number.
  assert.equal(renderFormat("AA-{YYYY}-{SEQ:3}", 12345, OCT_2026), "AA-2026-12345");
});

test("every occurrence of a date token is replaced", () => {
  assert.equal(renderFormat("{YYYY}-{YYYY}-{SEQ:2}", 3, OCT_2026), "2026-2026-03");
});

test("a format with no date token still renders", () => {
  assert.equal(renderFormat("POL-{SEQ:5}", 1, OCT_2026), "POL-00001");
});

test("rendering refuses an invalid format rather than minting a bad number", () => {
  assert.throws(() => renderFormat("POL-no-sequence", 1, OCT_2026), /sequence token/);
});

/* ----------------------------------------------------------------- periods */

test("a yearly format counts per year, a monthly one per month, neither forever", () => {
  assert.equal(periodFor("AA-{YYYY}-{SEQ:6}", OCT_2026), "2026");
  assert.equal(periodFor("AA-{MM}-{SEQ:6}", OCT_2026), "2026-10");
  assert.equal(periodFor("AA-{SEQ:6}", OCT_2026), "ALL");
});

test("a month token wins over a year token, so the counter restarts monthly", () => {
  assert.equal(periodFor("{YYYY}{MM}-{SEQ:4}", OCT_2026), "2026-10");
});

/* -------------------------------------------------------------- validation */

test("a format without a sequence token is rejected", () => {
  const r = validateFormat("AA-{YYYY}");
  assert.equal(r.ok, false);
  assert.match(r.message, /sequence token/);
});

test("an unknown token is rejected rather than printed literally", () => {
  const r = validateFormat("AA-{QUARTER}-{SEQ:4}");
  assert.equal(r.ok, false);
  assert.match(r.message, /Unknown token/);
});

test("an out-of-range sequence width is rejected", () => {
  assert.equal(validateFormat("AA-{SEQ:0}").ok, false);
  assert.equal(validateFormat("AA-{SEQ:13}").ok, false);
  assert.equal(validateFormat("AA-{SEQ:12}").ok, true);
});

test("an empty format is rejected", () => {
  assert.equal(validateFormat("").ok, false);
  assert.equal(validateFormat(null).ok, false);
});

test("a valid format reports the width the caller will pad to", () => {
  assert.deepEqual(validateFormat("AA-{YYYY}-{SEQ:6}"), { ok: true, width: 6 });
});
