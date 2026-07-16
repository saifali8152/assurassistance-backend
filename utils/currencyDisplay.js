// Display conversion for partner invoices (and other reports that store amounts in XOF).
// Mirrors frontend/src/context/CurrencyContext.tsx + currencyService.ts fallbacks.
// XOF is the database base currency; USD/EUR are display conversions.

export const SUPPORTED_CURRENCIES = ["XOF", "USD", "EUR"];

/** 1 XOF → target currency (same fallbacks as the frontend CurrencySelector). */
const RATES_FROM_XOF = {
  XOF: 1,
  USD: 0.0016667, // ≈ 600 XOF = 1 USD
  EUR: 1 / 655.957, // CFA franc peg: 1 EUR = 655.957 XOF
};

export function normalizeCurrency(input) {
  const cur = String(input || "XOF").toUpperCase();
  return SUPPORTED_CURRENCIES.includes(cur) ? cur : "XOF";
}

export function currencyLabel(currency) {
  const cur = normalizeCurrency(currency);
  if (cur === "XOF") return "FCFA";
  return cur;
}

/** Convert an amount stored in XOF to the display currency. */
export function convertFromXof(amountXof, currency = "XOF") {
  const n = Number(amountXof);
  if (!Number.isFinite(n)) return 0;
  const cur = normalizeCurrency(currency);
  return n * RATES_FROM_XOF[cur];
}

/**
 * Format a XOF-stored amount for display in the given currency.
 * XOF → whole FCFA; USD/EUR → 2 decimal places with currency code.
 */
export function formatFromXof(amountXof, currency = "XOF", locale = "fr") {
  const cur = normalizeCurrency(currency);
  const converted = convertFromXof(amountXof, cur);
  const loc = locale === "fr" ? "fr-FR" : "en-US";
  if (cur === "XOF") {
    return `${Math.round(converted).toLocaleString(loc).replace(/\u202f|\u00a0/g, " ")} FCFA`;
  }
  return `${converted.toLocaleString(loc, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${cur}`;
}

/** Compact cell value (no currency suffix — used in dense PDF tables). */
export function formatAmountCell(amountXof, currency = "XOF", locale = "fr") {
  const cur = normalizeCurrency(currency);
  const converted = convertFromXof(amountXof, cur);
  const loc = locale === "fr" ? "fr-FR" : "en-US";
  if (cur === "XOF") {
    return String(Math.round(converted));
  }
  return converted.toLocaleString(loc, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
