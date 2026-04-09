/**
 * Departure = trip start (case.start_date), date-only from DB.
 * Operators may edit limited fields only while more than 24h before departure.
 * In the last 24h before departure (and after departure), only admin may edit.
 */

const MS_DAY = 24 * 60 * 60 * 1000;

export function parseStartDateMs(startDate) {
  if (startDate == null) return null;
  const s = String(startDate).trim();
  if (!s) return null;
  const iso = s.length <= 10 && !s.includes("T") ? `${s}T00:00:00` : s;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/** ms from now until departure (negative if already started) */
export function msUntilDeparture(startDate) {
  const dep = parseStartDateMs(startDate);
  if (dep == null) return null;
  return dep - Date.now();
}

/** Operator window: strictly more than 24h before departure */
export function operatorLimitedEditOpen(startDate) {
  const ms = msUntilDeparture(startDate);
  if (ms == null) return false;
  return ms > MS_DAY;
}

/** Last 24h before departure (not yet departed) */
export function inLast24HoursBeforeDeparture(startDate) {
  const ms = msUntilDeparture(startDate);
  if (ms == null) return false;
  return ms > 0 && ms <= MS_DAY;
}

export function hasDeparted(startDate) {
  const ms = msUntilDeparture(startDate);
  if (ms == null) return false;
  return ms <= 0;
}

export const MAX_OPERATOR_POLICY_EDITS = 3;
