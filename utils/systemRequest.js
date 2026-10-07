// src/utils/systemRequest.js
//
// A request-shaped object for work that has no request behind it.
//
// The certificate payload builder takes an Express `req`, and for a good reason:
// the absolute URLs it prints (the QR target, a partner logo) depend on the host
// the caller reached us on. A payment callback, the status poller and the expiry
// sweeper have no `req` at all, and passing `{ get: () => "" }` would quietly
// produce a QR code pointing at a relative path — a certificate that looks right
// and scans to nothing.
//
// So this builds the same answers from the configured public base URL, which is
// the host those background paths are supposed to speak as.
//
export function systemRequest({ locale = null } = {}) {
  const base = (process.env.PUBLIC_API_URL || process.env.BASE_URL || "").trim();
  let host = "";
  let proto = "https";
  if (base) {
    try {
      const u = new URL(base);
      host = u.host;
      proto = u.protocol.replace(/:$/, "") || "https";
    } catch {
      // A malformed BASE_URL is a misconfiguration, not a reason to crash a
      // payment callback: fall through to the relative form.
    }
  }

  const acceptLanguage = locale ? (String(locale).toLowerCase().startsWith("fr") ? "fr-FR" : "en") : "";

  return {
    protocol: proto,
    query: {},
    params: {},
    get(name) {
      const key = String(name || "").toLowerCase();
      if (key === "host" || key === "x-forwarded-host") return host;
      if (key === "x-forwarded-proto") return proto;
      if (key === "accept-language") return acceptLanguage;
      return "";
    },
  };
}

export default systemRequest;
