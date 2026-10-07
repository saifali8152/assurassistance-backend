// tests/idempotency.test.mjs
//
// The Idempotency-Key fingerprint is what stops one key being reused for a
// different request. These pin the two properties it needs: key order must not
// matter, and a changed value must.
//
import test from "node:test";
import assert from "node:assert/strict";

import { __testables } from "../middlewares/idempotencyMiddleware.js";

const { fingerprint, sortDeep } = __testables;

test("key order does not change the fingerprint", () => {
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
});

test("nested key order does not change it either", () => {
  assert.equal(
    fingerprint({ outer: { x: 1, y: 2 }, z: 3 }),
    fingerprint({ z: 3, outer: { y: 2, x: 1 } })
  );
});

test("a changed value changes the fingerprint", () => {
  assert.notEqual(fingerprint({ total: 100 }), fingerprint({ total: 101 }));
});

test("array order is preserved, because order is meaningful in a list", () => {
  assert.notEqual(fingerprint({ ids: [1, 2] }), fingerprint({ ids: [2, 1] }));
});

test("an absent body and an explicit null hash the same", () => {
  assert.equal(fingerprint(undefined), fingerprint(null));
});

test("sortDeep leaves primitives alone", () => {
  assert.equal(sortDeep(5), 5);
  assert.equal(sortDeep("x"), "x");
  assert.equal(sortDeep(null), null);
});
