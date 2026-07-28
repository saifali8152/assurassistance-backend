// Display conversion for partner invoices and reports.
// Sale amounts are stored in the plan/sale currency (often XOF, sometimes USD for Agico).
// The UI selector chooses a *display* currency; we convert from the source currency.

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

/** Convert an amount from one supported currency to another. */
export function convertAmount(amount, fromCurrency = "XOF", toCurrency = "XOF") {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);
  if (from === to) return n;
  const inXof = from === "XOF" ? n : n / RATES_FROM_XOF[from];
  return inXof * RATES_FROM_XOF[to];
}

/** @deprecated Prefer convertAmount(amount, "XOF", currency). */
export function convertFromXof(amountXof, currency = "XOF") {
  return convertAmount(amountXof, "XOF", currency);
}

/**
 * Format an amount for display.
 * @param amount numeric amount in `fromCurrency`
 * @param displayCurrency target display currency
 * @param locale "fr" | "en"
 * @param fromCurrency currency the amount is stored in (default XOF for legacy callers)
 */
export function formatAmount(amount, displayCurrency = "XOF", locale = "fr", fromCurrency = "XOF") {
  const cur = normalizeCurrency(displayCurrency);
  const converted = convertAmount(amount, fromCurrency, cur);
  const loc = locale === "fr" ? "fr-FR" : "en-US";
  if (cur === "XOF") {
    return `${Math.round(converted).toLocaleString(loc).replace(/\u202f|\u00a0/g, " ")} FCFA`;
  }
  return `${converted.toLocaleString(loc, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${cur}`;
}

/** @deprecated Prefer formatAmount(amount, currency, locale, "XOF"). */
export function formatFromXof(amountXof, currency = "XOF", locale = "fr") {
  return formatAmount(amountXof, currency, locale, "XOF");
}

/** Compact cell value (no currency suffix — used in dense PDF tables). */
export function formatAmountCell(amount, displayCurrency = "XOF", locale = "fr", fromCurrency = "XOF") {
  const cur = normalizeCurrency(displayCurrency);
  const converted = convertAmount(amount, fromCurrency, cur);
  const loc = locale === "fr" ? "fr-FR" : "en-US";
  if (cur === "XOF") {
    return String(Math.round(converted));
  }
  return converted.toLocaleString(loc, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
