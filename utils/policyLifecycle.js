/**
 * Canonical deletion reasons for soft-deleted policies (admin only).
 * Stored in sales.deletion_reason exactly as listed.
 */
export const POLICY_DELETION_REASONS = [
  "Test policy",
  "Customer desistement",
  "Error or duplicate",
  "Cancellation before reversal",
];

export const MAX_PAYMENT_REVERSES = 2;

export function isValidDeletionReason(reason) {
  return POLICY_DELETION_REASONS.includes(String(reason || "").trim());
}

/** Whether a sale row is soft-deleted. */
export function isSaleSoftDeleted(row) {
  return row != null && row.deleted_at != null;
}

/**
 * Present a sale/ledger line for API/UI: soft-deleted policies keep identifiers
 * but premium, tax, total, commission and received are forced to 0.
 */
export function applySoftDeletedSaleDisplay(row) {
  if (!row || !isSaleSoftDeleted(row)) return row;
  return {
    ...row,
    plan_price: 0,
    plan_premium: 0,
    premium_amount: 0,
    tax: 0,
    total: 0,
    commission: 0,
    net_to_transfer: 0,
    received_amount: 0,
    is_deleted: true,
    deletion_reason: row.deletion_reason || null,
    deleted_at: row.deleted_at,
  };
}
