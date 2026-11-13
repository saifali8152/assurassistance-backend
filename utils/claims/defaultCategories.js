// src/utils/claims/defaultCategories.js
//
// The claim categories the platform ships with — the authoritative list from the
// client's plan: 4 categories, 17 sub-categories, FR and EN.
//
// THIS FILE IS THE SOURCE OF THE SEED, NOT OF THE RUNTIME LIST. The migration
// m4_03_claim_categories.sql is generated from it (scripts/generateClaimSeed.js)
// and inserts with INSERT IGNORE, so the database is what the flow reads from
// and what the admin edits. Changing this file after the migration has run does
// nothing to a live database — by design: once the client edits a category in
// the admin panel, a deploy must never overwrite it.
//
// LIMITS THAT SHAPE THE TEXT
//   * name   ≤ 24 characters — a WhatsApp list-row title is cut at 24.
//   * hint   ≤ 72 characters — the list-row description limit.
//   * at most 10 sub-categories per category — a WhatsApp list holds 10 rows.
//
// FIELD SHAPES
//   document:    { code, label_fr, label_en }
//   extra field: { key, type: text|number|date|choice, required,
//                  label_fr, label_en, prompt_fr, prompt_en,
//                  min?, max?, max_length?, options?: [{ value, label_fr, label_en }] }
//
// guarantee_codes are the coverageType codes used in a plan's guarantees (the
// same keys the certificate prints). null means "no guarantee on any plan maps to
// this", and the coverage check is skipped rather than flagging every claim.
//

const doc = (code, label_fr, label_en) => ({ code, label_fr, label_en });

const D = {
  boardingPass: doc("boarding_pass", "Carte d'embarquement", "Boarding pass"),
  delayCertificate: doc("delay_certificate", "Attestation de retard de la compagnie", "Airline delay certificate"),
  expenseReceipts: doc("expense_receipts", "Justificatifs de dépenses", "Expense receipts"),
  bookingProof: doc("booking_proof", "Justificatif de réservation", "Booking confirmation"),
  cancellationProof: doc("cancellation_proof", "Justificatif du motif d'annulation", "Proof of the reason for cancellation"),
  refundStatement: doc("refund_statement", "Relevé de remboursement", "Refund statement"),
  pir: doc("pir", "Rapport d'irrégularité bagage (PIR)", "Property irregularity report (PIR)"),
  airlineLetter: doc("airline_letter", "Courrier d'indemnisation de la compagnie", "Airline compensation letter"),
  purchaseReceipts: doc("purchase_receipts", "Factures d'achat", "Purchase receipts"),
  policeReport: doc("police_report", "Déclaration de perte ou de vol / rapport de police", "Loss or theft declaration / police report"),
  replacementReceipts: doc("replacement_receipts", "Frais de remplacement", "Replacement costs"),
  photos: doc("photos", "Photos", "Photos"),
  medicalReport: doc("medical_report", "Rapport médical", "Medical report"),
  medicalInvoices: doc("medical_invoices", "Factures médicales", "Medical invoices"),
  prescriptions: doc("prescriptions", "Ordonnances", "Prescriptions"),
  admissionCertificate: doc("admission_certificate", "Bulletin d'hospitalisation", "Hospital admission certificate"),
  medicalCertificate: doc("medical_certificate", "Certificat médical", "Medical certificate"),
  thirdPartyClaim: doc("third_party_claim", "Réclamation du tiers", "Third-party claim"),
  legalDocuments: doc("legal_documents", "Documents juridiques", "Legal documents"),
  withdrawalProof: doc("withdrawal_proof", "Justificatif de retrait", "Proof of withdrawal"),
};

const text = (key, label_fr, label_en, prompt_fr, prompt_en, { required = true, max_length = 120 } = {}) => ({
  key, type: "text", required, label_fr, label_en, prompt_fr, prompt_en, max_length,
});
const number = (key, label_fr, label_en, prompt_fr, prompt_en, { required = true, min = 0, max = 100000000 } = {}) => ({
  key, type: "number", required, label_fr, label_en, prompt_fr, prompt_en, min, max,
});
const date = (key, label_fr, label_en, prompt_fr, prompt_en, { required = true } = {}) => ({
  key, type: "date", required, label_fr, label_en, prompt_fr, prompt_en,
});

const F = {
  flightNumber: text(
    "flight_number", "Numéro de vol", "Flight number",
    "Quel est le numéro de vol ? (ex. AF703)", "What is the flight number? (e.g. AF703)",
    { max_length: 12 }
  ),
  airline: text(
    "airline", "Compagnie aérienne", "Airline",
    "Quelle compagnie aérienne ? Répondez *PASSER* si vous ne savez pas.", "Which airline? Reply *SKIP* if you don't know.",
    { required: false, max_length: 60 }
  ),
  delayHours: number(
    "delay_hours", "Durée du retard (heures)", "Delay (hours)",
    "Combien d'heures de retard ? (un nombre, ex. 5)", "How many hours late? (a number, e.g. 5)",
    { min: 0, max: 720 }
  ),
  cancellationReason: text(
    "cancellation_reason", "Motif de l'annulation", "Reason for cancellation",
    "Pour quelle raison le voyage a-t-il été annulé ?", "Why was the trip cancelled?",
    { max_length: 300 }
  ),
  bookingAmount: number(
    "booking_amount", "Montant de la réservation", "Booking amount",
    "Quel était le montant payé pour la réservation ? Répondez *PASSER* si vous ne savez pas.", "How much was paid for the booking? Reply *SKIP* if you don't know.",
    { required: false }
  ),
  estimatedValue: number(
    "estimated_value", "Valeur estimée", "Estimated value",
    "Quelle est la valeur estimée ? Répondez *PASSER* si vous ne savez pas.", "What is the estimated value? Reply *SKIP* if you don't know.",
    { required: false }
  ),
  documentType: {
    key: "lost_document", type: "choice", required: true,
    label_fr: "Document perdu", label_en: "Document lost",
    prompt_fr: "Quel document a été perdu ?", prompt_en: "Which document was lost?",
    options: [
      { value: "passport", label_fr: "Passeport", label_en: "Passport" },
      { value: "visa", label_fr: "Visa", label_en: "Visa" },
      { value: "id_card", label_fr: "Carte d'identité", label_en: "ID card" },
      { value: "other", label_fr: "Autre", label_en: "Other" },
    ],
  },
  policeReportNumber: text(
    "police_report_number", "N° de rapport de police", "Police report number",
    "Quel est le numéro du rapport de police ? Répondez *PASSER* si vous n'en avez pas.", "What is the police report number? Reply *SKIP* if you don't have one.",
    { required: false, max_length: 60 }
  ),
  facilityName: text(
    "facility_name", "Établissement de santé", "Healthcare facility",
    "Dans quel établissement avez-vous été soigné ?", "Which facility treated you?",
    { max_length: 120 }
  ),
  hospitalName: text(
    "hospital_name", "Hôpital", "Hospital",
    "Dans quel hôpital ?", "Which hospital?",
    { max_length: 120 }
  ),
  admissionDate: date(
    "admission_date", "Date d'admission", "Admission date",
    "Quelle est la date d'admission ? (JJ/MM/AAAA)", "What is the admission date? (DD/MM/YYYY)"
  ),
  disabilityDays: number(
    "disability_days", "Durée d'incapacité (jours)", "Disability (days)",
    "Combien de jours d'incapacité ? Répondez *PASSER* si vous ne savez pas.", "How many days of disability? Reply *SKIP* if you don't know.",
    { required: false, min: 0, max: 3650 }
  ),
  thirdPartyName: text(
    "third_party_name", "Nom du tiers", "Third party's name",
    "Quel est le nom de la personne ou de l'organisme concerné ? Répondez *PASSER* si vous ne savez pas.", "What is the name of the other party? Reply *SKIP* if you don't know.",
    { required: false, max_length: 120 }
  ),
  bailAmount: number(
    "bail_amount", "Montant de la caution", "Bail amount",
    "Quel est le montant de la caution demandée ? Répondez *PASSER* si vous ne savez pas.", "What bail amount is required? Reply *SKIP* if you don't know.",
    { required: false }
  ),
  authority: text(
    "authority", "Autorité", "Authority",
    "Quelle autorité est impliquée (police, tribunal…) ? Répondez *PASSER* si vous ne savez pas.", "Which authority is involved (police, court…)? Reply *SKIP* if you don't know.",
    { required: false, max_length: 120 }
  ),
  amountLost: number(
    "amount_lost", "Montant perdu", "Amount lost",
    "Quel montant a été perdu ?", "How much was lost?",
    { min: 0 }
  ),
};

const sub = (parent, sort_order, code, name_fr, name_en, hint_fr, hint_en, o = {}) => ({
  code, parent_code: parent, sort_order, name_fr, name_en, hint_fr, hint_en,
  required_documents: o.required || [],
  optional_documents: o.optional || [],
  extra_fields: o.fields || [],
  default_priority: o.priority || "normal",
  guarantee_codes: o.guarantees || null,
});

export const DEFAULT_CATEGORIES = [
  // ---------------------------------------------------------------- parents
  {
    code: "travel", parent_code: null, sort_order: 10,
    name_fr: "Voyage", name_en: "Travel",
    hint_fr: "Vol, bagages, annulation, documents, vol d'effets", hint_en: "Flights, baggage, cancellation, documents, theft",
    required_documents: [], optional_documents: [], extra_fields: [], default_priority: "normal", guarantee_codes: null,
  },
  {
    code: "medical", parent_code: null, sort_order: 20,
    name_fr: "Médical", name_en: "Medical",
    hint_fr: "Soins, hospitalisation, téléconsultation, rapatriement", hint_en: "Treatment, hospital, teleconsultation, repatriation",
    required_documents: [], optional_documents: [], extra_fields: [], default_priority: "normal", guarantee_codes: null,
  },
  {
    code: "accident", parent_code: null, sort_order: 30,
    name_fr: "Accident", name_en: "Accident",
    hint_fr: "Accident corporel, incapacité, invalidité", hint_en: "Personal accident, disability",
    required_documents: [], optional_documents: [], extra_fields: [], default_priority: "normal", guarantee_codes: null,
  },
  {
    code: "legal", parent_code: null, sort_order: 40,
    name_fr: "Juridique", name_en: "Legal",
    hint_fr: "Responsabilité civile, assistance juridique, caution", hint_en: "Liability, legal assistance, bail, cash loss",
    required_documents: [], optional_documents: [], extra_fields: [], default_priority: "normal", guarantee_codes: null,
  },

  // ----------------------------------------------------------------- travel
  sub("travel", 11, "flight_delay", "Retard de vol", "Flight delay",
    "Votre vol est parti ou arrivé en retard", "Your flight left or arrived late", {
      required: [D.boardingPass, D.delayCertificate], optional: [D.expenseReceipts],
      fields: [F.flightNumber, F.airline, F.delayHours],
    }),
  sub("travel", 12, "trip_cancellation", "Annulation de voyage", "Trip cancellation",
    "Vous avez dû annuler votre voyage", "You had to cancel your trip", {
      required: [D.bookingProof, D.cancellationProof], optional: [D.refundStatement],
      fields: [F.cancellationReason, F.bookingAmount], guarantees: ["tripCancellation"],
    }),
  sub("travel", 13, "baggage_delay", "Retard de bagages", "Baggage delay",
    "Vos bagages sont arrivés en retard", "Your baggage arrived late", {
      required: [D.boardingPass, D.pir], optional: [D.purchaseReceipts],
      fields: [F.flightNumber, F.delayHours], guarantees: ["baggageDeliveryDelay"],
    }),
  sub("travel", 14, "baggage_loss", "Perte de bagages", "Baggage loss",
    "Vos bagages ont été perdus", "Your baggage was lost", {
      required: [D.pir, D.boardingPass], optional: [D.airlineLetter, D.purchaseReceipts],
      fields: [F.flightNumber, F.estimatedValue],
    }),
  sub("travel", 15, "travel_document_loss", "Perte de documents", "Travel document loss",
    "Passeport, visa ou pièce d'identité perdu", "Lost passport, visa or ID", {
      required: [D.policeReport], optional: [D.replacementReceipts],
      fields: [F.documentType, F.policeReportNumber], guarantees: ["passportLoss"],
    }),
  sub("travel", 16, "theft", "Vol d'effets personnels", "Theft of belongings",
    "Des affaires personnelles vous ont été volées", "Personal belongings were stolen", {
      required: [D.policeReport], optional: [D.purchaseReceipts, D.photos],
      fields: [F.policeReportNumber, F.estimatedValue],
    }),

  // ---------------------------------------------------------------- medical
  sub("medical", 21, "medical_treatment", "Soins médicaux", "Medical treatment",
    "Consultation ou soins pendant le voyage", "Consultation or treatment while travelling", {
      required: [D.medicalReport], optional: [D.medicalInvoices, D.prescriptions],
      fields: [F.facilityName], guarantees: ["medicalEmergencies"],
    }),
  sub("medical", 22, "hospitalization", "Hospitalisation", "Hospitalisation",
    "Vous êtes ou avez été hospitalisé", "You are or were admitted to hospital", {
      required: [D.admissionCertificate], optional: [D.medicalReport, D.medicalInvoices],
      fields: [F.hospitalName, F.admissionDate], priority: "urgent", guarantees: ["hospitalization"],
    }),
  sub("medical", 23, "teleconsultation", "Téléconsultation", "Teleconsultation",
    "Consultation médicale à distance", "Remote medical consultation", {
      optional: [D.prescriptions, D.medicalReport], guarantees: ["medicalEmergencies"],
    }),
  sub("medical", 24, "medical_repatriation", "Rapatriement médical", "Medical repatriation",
    "Transport médical ou retour au pays", "Medical transport or return home", {
      required: [D.medicalReport], optional: [D.admissionCertificate],
      fields: [F.hospitalName], priority: "urgent", guarantees: ["evacuationRepatriation", "medicalTransport"],
    }),

  // --------------------------------------------------------------- accident
  sub("accident", 31, "personal_accident", "Accident corporel", "Personal accident",
    "Vous avez été blessé dans un accident", "You were injured in an accident", {
      required: [D.medicalReport], optional: [D.policeReport, D.photos],
      fields: [{ ...F.facilityName, required: false, prompt_fr: "Dans quel établissement avez-vous été soigné ? Répondez *PASSER* si vous n'avez pas été soigné.", prompt_en: "Which facility treated you? Reply *SKIP* if you were not treated." }],
      priority: "high",
    }),
  sub("accident", 32, "temporary_disability", "Incapacité temporaire", "Temporary disability",
    "Incapacité de travail temporaire", "Temporarily unable to work", {
      required: [D.medicalCertificate], optional: [D.medicalReport],
      fields: [F.disabilityDays],
    }),
  sub("accident", 33, "permanent_disability", "Invalidité permanente", "Permanent disability",
    "Invalidité permanente suite à un accident", "Permanent disability after an accident", {
      required: [D.medicalCertificate, D.medicalReport], priority: "high",
    }),

  // ------------------------------------------------------------------ legal
  sub("legal", 41, "third_party_liability", "Responsabilité civile", "Third-party liability",
    "Vous avez causé un dommage à un tiers", "You caused damage or injury to someone", {
      optional: [D.thirdPartyClaim, D.policeReport, D.photos],
      fields: [F.thirdPartyName], guarantees: ["civilLiability"],
    }),
  sub("legal", 42, "legal_assistance", "Assistance juridique", "Legal assistance",
    "Vous avez besoin d'un avocat ou d'un conseil", "You need a lawyer or legal advice", {
      optional: [D.legalDocuments], priority: "high", guarantees: ["legalAssistance"],
    }),
  sub("legal", 43, "bail_advance", "Avance de caution", "Bail advance",
    "Une caution pénale vous est demandée", "Bail is being demanded from you", {
      optional: [D.legalDocuments], fields: [F.bailAmount, F.authority],
      priority: "urgent", guarantees: ["bail"],
    }),
  sub("legal", 44, "cash_loss", "Perte d'argent", "Cash loss",
    "Perte ou vol d'argent liquide", "Lost or stolen cash", {
      required: [D.policeReport], optional: [D.withdrawalProof],
      fields: [F.amountLost],
    }),
];

export const NAME_MAX = 24;
export const HINT_MAX = 72;
export const MAX_SUBCATEGORIES_PER_CATEGORY = 10;
export const PRIORITIES = ["normal", "high", "urgent"];
export const FIELD_TYPES = ["text", "number", "date", "choice"];
