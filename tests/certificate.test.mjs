// tests/certificate.test.mjs
//
// The certificate PDF, which until now was English-only while the browser
// version was fully translated, and which interpolated traveller names straight
// into a renderer whose fonts cannot encode most of Unicode.
//
// These render a real PDF in memory — no database, no HTTP — so a character
// that breaks pdfkit fails here rather than when a customer asks for their
// certificate.
//
import test from "node:test";
import assert from "node:assert/strict";

import { generateCertificatePdfFromPagePayload, safeText } from "../utils/certificatePagePdf.js";

/* ------------------------------------------------------------- safeText */

test("accents cp1252 has are kept exactly as written", () => {
  // These are the characters French actually uses. Folding them would be a
  // regression, not a safety measure.
  for (const s of ["Côte d'Ivoire", "éèêë", "àâä", "ùûü", "ç", "ÿ", "N°", "œ" === "œ" ? "garçon" : ""]) {
    assert.equal(safeText(s), s, `${s} should survive untouched`);
  }
});

test("a decomposed accent is recomposed rather than stripped", () => {
  // "e" + combining acute must become "é", not a bare "e".
  assert.equal(safeText("e\u0301"), "é");
  assert.equal(safeText("Franc\u0327ois"), "François");
  // A mark with no precomposed Latin-1 form folds to its base letter rather
  // than surviving as a character pdfkit cannot encode.
  assert.equal(safeText("t\u0301"), "t");
});

test("characters pdfkit cannot encode are folded to their closest Latin-1 form", () => {
  assert.equal(safeText("Łukasz Kraśnik"), "Lukasz Krasnik");
  assert.equal(safeText("Ayşe Yılmaz"), "Ayse Yilmaz");
  assert.equal(safeText("Ōsaka"), "Osaka");
  assert.equal(safeText("œuvre"), "oeuvre");
});

test("typographic punctuation is folded to ASCII", () => {
  assert.equal(safeText("a — b … c"), "a - b ... c");
  assert.equal(safeText("‘quoted’"), "'quoted'");
});

test("a script with no Latin equivalent degrades rather than throwing", () => {
  assert.equal(safeText("Владимир"), "????????");
  assert.equal(safeText("日本"), "??");
});

test("null and undefined become an empty string, never the word null", () => {
  assert.equal(safeText(null), "");
  assert.equal(safeText(undefined), "");
  assert.equal(safeText(0), "0");
});

/* --------------------------------------------------------------- render */

const PAYLOAD = (over = {}) => ({
  certificateNumber: "CERT-2026-000042",
  policyNumber: "AA-2026-000042",
  invoiceNumber: "INV-2026-000042",
  issuedOn: "06/10/2026",
  productType: "Travel",
  publicViewUrl: "https://example.test/certificate-public/abc",
  traveller: {
    givenNames: "Saif",
    surname: "Ali",
    fullName: "Saif Ali",
    dateOfBirth: "12/03/1990",
    passportOrId: "AB1234567",
    gender: "Male",
    nationality: "Pakistan",
    countryOfResidence: "Côte d'Ivoire",
  },
  coverage: {
    periodFrom: "01/11/2026",
    periodTo: "10/11/2026",
    stayDays: 10,
    validityDays: 10,
    destinations: "France",
    email: "saif@example.test",
    phone: "+2250718923194",
    planName: "Agico Retail",
    currency: "XOF",
    worldwideLabel: "Worldwide",
  },
  pricing: { premiumAmount: 20, tax: 0, total: 20, showPremium: true, fixedDurationPremiums: true },
  benefits: [
    { categoryHeader: "MEDICAL", benefit: "Frais médicaux", level: "30 000 000 FCFA" },
    { categoryHeader: "LEGAL", benefit: "Assistance juridique", level: "1 500 000 FCFA" },
  ],
  qrDataUrl: null,
  themeColor: "#E4590F",
  extraIdFields: false,
  contact: { whatsapp: "+225 07 18 92 31 94", websiteUrl: "assurassistancepro.org" },
  footer: { line1: "ASSUR'ASSISTANCE SARL — Abidjan, Côte d'Ivoire" },
  ...over,
});

const isPdf = (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 5).toString("latin1") === "%PDF-";

test("renders a valid PDF in English", async () => {
  const buf = await generateCertificatePdfFromPagePayload(PAYLOAD(), true, { locale: "en" });
  assert.ok(isPdf(buf), "output should be a PDF");
  assert.ok(buf.length > 1000, "a one-page certificate should not be nearly empty");
});

test("renders a valid PDF in French", async () => {
  const buf = await generateCertificatePdfFromPagePayload(PAYLOAD(), true, { locale: "fr" });
  assert.ok(isPdf(buf));
});

test("the two languages produce different documents", async () => {
  // If the locale were ignored — which it was until now — these would match.
  const en = await generateCertificatePdfFromPagePayload(PAYLOAD(), true, { locale: "en" });
  const fr = await generateCertificatePdfFromPagePayload(PAYLOAD(), true, { locale: "fr" });
  assert.notEqual(en.length, fr.length, "French labels should change the document");
});

test("a locale like fr-FR is understood", async () => {
  const buf = await generateCertificatePdfFromPagePayload(PAYLOAD(), true, { locale: "fr-FR" });
  assert.ok(isPdf(buf));
});

test("an unknown locale falls back to English rather than failing", async () => {
  const buf = await generateCertificatePdfFromPagePayload(PAYLOAD(), true, { locale: "xx" });
  assert.ok(isPdf(buf));
});

test("a name pdfkit cannot encode still produces a certificate", async () => {
  // The whole point of safeText: before it, this threw mid-render and the
  // customer got nothing.
  const buf = await generateCertificatePdfFromPagePayload(
    PAYLOAD({
      traveller: {
        ...PAYLOAD().traveller,
        givenNames: "Ayşe",
        surname: "Yılmaz-Łukasz",
        countryOfResidence: "Türkiye",
      },
    }),
    true,
    { locale: "fr" }
  );
  assert.ok(isPdf(buf));
});

test("a benefit label in a non-Latin script does not break the render", async () => {
  const buf = await generateCertificatePdfFromPagePayload(
    PAYLOAD({ benefits: [{ categoryHeader: "MEDICAL", benefit: "Медицина", level: "1 000 000" }] }),
    true,
    { locale: "fr" }
  );
  assert.ok(isPdf(buf));
});

test("a certificate with no benefits configured still renders", async () => {
  const buf = await generateCertificatePdfFromPagePayload(PAYLOAD({ benefits: [] }), true, { locale: "fr" });
  assert.ok(isPdf(buf));
});

test("missing optional fields do not stop a certificate being issued", async () => {
  const buf = await generateCertificatePdfFromPagePayload(
    PAYLOAD({ invoiceNumber: null, contact: {}, footer: {}, coverage: { ...PAYLOAD().coverage, email: "", phone: "" } }),
    true,
    { locale: "en" }
  );
  assert.ok(isPdf(buf));
});
