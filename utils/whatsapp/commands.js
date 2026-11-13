// src/utils/whatsapp/commands.js
//
// Global commands, recognised at ANY point in the conversation.
//
// The milestone requires RESTART / BACK / HELP / AGENT and a language switch to
// work from every step. Detection happens before step parsing, so a customer who
// types AIDE while being asked for a passport number gets help rather than a
// validation error about their "passport".
//
// MATCHING RULES, and why they are conservative:
//   * Accent- and case-insensitive, punctuation stripped, so "aide", "AIDE" and
//     "aide !" all match.
//   * A command must be the WHOLE message. "My name is Restart Jones" is a name,
//     not a command, and treating it as one would be worse than useless.
//   * Greetings are recognised separately: they start a conversation but must not
//     hijack an answer mid-flow (a customer can be called "Salut" — unlikely —
//     but more importantly "bonjour" as an answer to "last name?" should be a
//     validation error, not a restart).
//
export const COMMANDS = {
  RESTART: "restart",
  BACK: "back",
  HELP: "help",
  AGENT: "agent",
  LANGUAGE_FR: "language_fr",
  LANGUAGE_EN: "language_en",
  CANCEL: "cancel",
  CERTIFICATE: "certificate",
  // Milestone 4. Recognised whether or not claims are switched on: when they
  // are off, the engine answers with a neutral "coming soon" instead of
  // mistaking the request for an answer to the current question.
  CLAIM: "claim",
  TRACK: "track",
};

const TABLE = [
  { command: COMMANDS.RESTART, words: ["restart", "recommencer", "recommence", "reset", "redemarrer", "reprendre a zero"] },
  { command: COMMANDS.BACK, words: ["back", "retour", "retourner", "precedent", "previous"] },
  { command: COMMANDS.HELP, words: ["help", "aide", "aidez moi", "menu", "commandes", "commands"] },
  { command: COMMANDS.AGENT, words: ["agent", "conseiller", "humain", "human", "operateur", "operator", "support", "assistance humaine"] },
  { command: COMMANDS.LANGUAGE_EN, words: ["english", "anglais", "en anglais", "in english"] },
  { command: COMMANDS.LANGUAGE_FR, words: ["francais", "french", "en francais", "in french"] },
  { command: COMMANDS.CANCEL, words: ["cancel", "annuler", "stop", "arreter"] },
  // Asking for the certificate again. A customer who has paid and lost the
  // document should not have to find a human for it, and the words they
  // actually use are "attestation" and "certificate" — not a command verb.
  //
  // Deliberately NOT here: "document", "police", "contrat" on their own. They
  // are too close to things a customer might legitimately type as an answer,
  // and misreading an answer as a command is worse than missing a command.
  {
    command: COMMANDS.CERTIFICATE,
    words: [
      "attestation",
      "mon attestation",
      "ma attestation",
      "mes attestations",
      "attestation assurance",
      "mon attestation assurance",
      "renvoyer attestation",
      "renvoyer mon attestation",
      "envoyer mon attestation",
      "recevoir mon attestation",
      "ma police assurance",
      "certificat",
      "mon certificat",
      "certificate",
      "my certificate",
      "send my certificate",
      "resend",
      "resend certificate",
      "resend my certificate",
      "my policy document",
      "insurance certificate",
    ],
  },
];

const GREETINGS = [
  "bonjour", "bonsoir", "salut", "coucou", "allo", "hello", "hi", "hey",
  "good morning", "good evening", "bjr", "slt",
];

export function normalizeCommandText(input) {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @returns {string|null} one of COMMANDS, or null when the message is an answer.
 */
export function detectCommand(input) {
  const s = normalizeCommandText(input);
  if (!s) return null;
  // One intent gets a looser reading: a customer asking for their certificate
  // back writes a short sentence, not a keyword ("je veux mon attestation svp").
  // Only this one, and only a short sentence with no digits in it, because for
  // every other command the whole-message rule below is what stops a legitimate
  // answer being eaten.
  if (isCertificateRequest(s)) return COMMANDS.CERTIFICATE;
  // Same loose reading for claims, and for the same reason: people write
  // "je veux declarer un sinistre", not a keyword. Tracking is checked first —
  // "suivre mon sinistre" mentions a claim but asks about one.
  if (isTrackRequest(s)) return COMMANDS.TRACK;
  if (isClaimRequest(s)) return COMMANDS.CLAIM;
  // Guard against a long sentence that merely contains a command word.
  if (s.split(" ").length > 4) return null;
  for (const entry of TABLE) {
    if (entry.words.includes(s)) return entry.command;
  }
  return null;
}

const CERTIFICATE_WORDS = ["attestation", "attestations", "certificat", "certificate"];

/**
 * @param {string} normalised already through normalizeCommandText
 */
export function isCertificateRequest(normalised) {
  const s = normalizeCommandText(normalised);
  if (!s) return false;
  const words = s.split(" ");
  // Short enough to be a request rather than a sentence that happens to mention
  // the word, and with no digits — a reply carrying a number is an answer.
  if (words.length > 5) return false;
  if (/\d/.test(s)) return false;
  return words.some((w) => CERTIFICATE_WORDS.includes(w));
}

const CLAIM_WORDS = ["sinistre", "sinistres", "claim", "claims"];
const TRACK_WORDS = ["suivi", "suivre", "track", "tracking", "statut", "status"];

/** "declarer un sinistre", "I want to make a claim" — short, no digits. */
export function isClaimRequest(normalised) {
  const s = normalizeCommandText(normalised);
  if (!s || /\d/.test(s)) return false;
  const words = s.split(" ");
  if (words.length > 6) return false;
  return words.some((w) => CLAIM_WORDS.includes(w));
}

/** "suivi", "suivre mon sinistre", "track my claim" — short, no digits. */
export function isTrackRequest(normalised) {
  const s = normalizeCommandText(normalised);
  if (!s || /\d/.test(s)) return false;
  const words = s.split(" ");
  if (words.length > 5) return false;
  if (!words.some((w) => TRACK_WORDS.includes(w))) return false;
  // "suivi" / "track" alone, or with a word that says what is tracked.
  return words.length === 1 || words.some((w) => ["sinistre", "claim", "dossier", "declaration", "case"].includes(w));
}

/**
 * "SUIVI SIN-2026-000123", "track SIN-2026-000123", "suivi de mon dossier SIN-…".
 * Carries a reference, so it has digits and is checked on the RAW text before
 * the command table (which refuses anything with digits).
 * @returns {{ reference: string } | null}
 */
export function parseTrackRequest(input) {
  const raw = String(input ?? "").trim();
  const m = /^(?:suivi|suivre|track|statut|status)\s+(?:(?:de|du|mon|ma|my|the|le|la)\s+)*(?:(?:dossier|sinistre|claim|case)\s+)?([A-Za-z]{1,6}[-\/ ]?\d{2,4}[-\/ ]?\d{1,8})$/i.exec(raw);
  if (!m) return null;
  return { reference: m[1].toUpperCase().replace(/\s+/g, "-").replace(/\//g, "-") };
}

export function isGreeting(input) {
  const s = normalizeCommandText(input);
  if (!s) return false;
  return GREETINGS.includes(s);
}

/** Buttons and list rows carry ids like "cmd:restart" — honoured the same way. */
export function detectCommandFromSelection(selectionId) {
  const id = String(selectionId ?? "");
  if (!id.startsWith("cmd:")) return null;
  const name = id.slice(4);
  return Object.values(COMMANDS).includes(name) ? name : null;
}

export function languageForCommand(command) {
  if (command === COMMANDS.LANGUAGE_EN) return "en";
  if (command === COMMANDS.LANGUAGE_FR) return "fr";
  return null;
}
