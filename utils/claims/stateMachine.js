// src/utils/claims/stateMachine.js
//
// The legal life of a claim.
//
//   draft ──► submitted ──► under_review ──► closed
//     │           └──────────────────────────► closed
//     └──► abandoned
//
// `draft` and `abandoned` belong to the customer side: a claim being filled in,
// and one that was never finished. `submitted → under_review → closed` belongs
// to the claims team (the dashboard). `closed` and `abandoned` are terminal —
// reopening a closed claim is adjudication workflow, which is out of contract.
//
// A transition table rather than scattered checks, so "can this happen?" has
// exactly one answer and the tests can enumerate every pair.
//
export const CLAIM_STATUSES = ["draft", "submitted", "under_review", "closed", "abandoned"];

export const CLAIM_TRANSITIONS = {
  draft: ["submitted", "abandoned"],
  submitted: ["under_review", "closed"],
  under_review: ["closed"],
  closed: [],
  abandoned: [],
};

export const TERMINAL_STATUSES = ["closed", "abandoned"];

/** Statuses the claims team may move a claim to from the dashboard. */
export const STAFF_TARGETS = ["under_review", "closed"];

export function canTransition(from, to) {
  return Boolean(CLAIM_TRANSITIONS[from]?.includes(to));
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}
