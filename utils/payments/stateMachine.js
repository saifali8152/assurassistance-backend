// src/utils/payments/stateMachine.js
//
// The legal transitions of a payment, enforced in code.
//
// WHY NOT A CHECK CONSTRAINT: a driver error naming a constraint tells an
// operator nothing. A refused transition here names both states and the actor,
// which is what you need at 2am when a provider has sent something unexpected.
//
// THE RULE THAT MATTERS: `completed` is terminal and is the ONLY state that may
// issue a policy. Nothing may leave it — not a late "failed" callback, not a
// retried sweep. Providers do re-send contradictory callbacks, and a system
// that lets `completed -> failed` through would revoke a policy the customer is
// already travelling on.
//
// `status_history` is append-only and carries every move, which is the audit
// trail the milestone asks for.
//
export const PAYMENT_STATES = [
  "pending",
  "initiated",
  "awaiting_confirmation",
  "completed",
  "failed",
  "expired",
  "cancelled",
];

/** Reachable states from each state. Empty array = terminal. */
export const TRANSITIONS = {
  // Created, not yet sent to the provider.
  //
  // `completed` and `awaiting_confirmation` are reachable from here on purpose.
  // A mobile money callback can beat our own HTTP response: the provider pushes
  // the prompt, the customer confirms, and the callback lands before the
  // initiation call has returned and we have written `initiated`. Refusing that
  // transition would strand a transaction the customer has already paid, and
  // the sweeper would later expire it — the worst outcome a payment system can
  // produce. The integration test that caught this is "a late failure callback
  // cannot undo a completed payment".
  //
  // What stops a payment being completed without money is not the order of
  // states but WHO may write `completed`: only a callback whose signature
  // verified and whose provider transaction id matched, or a status poll
  // against the provider's own API.
  pending: ["initiated", "awaiting_confirmation", "completed", "failed", "cancelled", "expired"],
  // The provider accepted the request; the customer has not acted yet.
  initiated: ["awaiting_confirmation", "completed", "failed", "cancelled", "expired"],
  // Prompt is on the customer's handset; we are waiting for the callback.
  awaiting_confirmation: ["completed", "failed", "cancelled", "expired"],
  // Terminal, all four.
  completed: [],
  failed: [],
  expired: [],
  cancelled: [],
};

export const TERMINAL_STATES = PAYMENT_STATES.filter((s) => TRANSITIONS[s].length === 0);

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

export function isKnownState(state) {
  return PAYMENT_STATES.includes(state);
}

/**
 * May a payment move from `from` to `to`?
 *
 * A move to the state it is already in is allowed and reported as a no-op, so a
 * duplicate callback that repeats the same outcome is boring rather than an
 * error — which is exactly how a provider's retries should be treated.
 *
 * @returns {{ok: boolean, noop?: boolean, reason?: string, message?: string}}
 */
export function canTransition(from, to) {
  if (!isKnownState(from)) {
    return { ok: false, reason: "unknown_state", message: `Unknown current state: ${from}` };
  }
  if (!isKnownState(to)) {
    return { ok: false, reason: "unknown_state", message: `Unknown target state: ${to}` };
  }
  if (from === to) return { ok: true, noop: true };
  if (isTerminal(from)) {
    return {
      ok: false,
      reason: "terminal_state",
      message: `A payment in ${from} is final and cannot move to ${to}`,
    };
  }
  if (!TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      reason: "illegal_transition",
      message: `${from} cannot move to ${to}`,
    };
  }
  return { ok: true };
}

/**
 * Build the history entry for a move. Pure, so the model can append it inside
 * whatever transaction it is already running.
 *
 * @param {string} from
 * @param {string} to
 * @param {{by?: string, note?: string, at?: Date}} meta
 */
export function historyEntry(from, to, meta = {}) {
  return {
    from,
    to,
    at: (meta.at || new Date()).toISOString(),
    by: meta.by || "system",
    ...(meta.note ? { note: String(meta.note).slice(0, 300) } : {}),
  };
}

/** Append to an existing history, tolerating a null or malformed column. */
export function appendHistory(existing, entry) {
  let list = [];
  if (Array.isArray(existing)) list = existing;
  else if (typeof existing === "string" && existing.trim()) {
    try {
      const parsed = JSON.parse(existing);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      // A corrupt history must not block a payment from progressing; we start a
      // fresh list rather than throwing in the money path.
      list = [];
    }
  }
  // Bounded, so a provider retrying thousands of times cannot grow one row
  // without limit. The oldest entries are the least useful in a dispute.
  const next = [...list, entry];
  return next.length > 100 ? next.slice(next.length - 100) : next;
}
