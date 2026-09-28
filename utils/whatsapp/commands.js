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
};

const TABLE = [
  { command: COMMANDS.RESTART, words: ["restart", "recommencer", "recommence", "reset", "redemarrer", "reprendre a zero"] },
  { command: COMMANDS.BACK, words: ["back", "retour", "retourner", "precedent", "previous"] },
  { command: COMMANDS.HELP, words: ["help", "aide", "aidez moi", "menu", "commandes", "commands"] },
  { command: COMMANDS.AGENT, words: ["agent", "conseiller", "humain", "human", "operateur", "operator", "support", "assistance humaine"] },
  { command: COMMANDS.LANGUAGE_EN, words: ["english", "anglais", "en anglais", "in english"] },
  { command: COMMANDS.LANGUAGE_FR, words: ["francais", "french", "en francais", "in french"] },
  { command: COMMANDS.CANCEL, words: ["cancel", "annuler", "stop", "arreter"] },
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
  // Guard against a long sentence that merely contains a command word.
  if (s.split(" ").length > 4) return null;
  for (const entry of TABLE) {
    if (entry.words.includes(s)) return entry.command;
  }
  return null;
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
