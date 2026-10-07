// src/utils/logger.js
//
// Structured logging.
//
// WHY: until now the backend logged with bare `console.*`, which is fine for
// tailing a terminal and useless for answering "what happened to this customer's
// conversation at 14:03". The WhatsApp module makes that question routine —
// a webhook arrives, a step advances, three outbound calls go to Meta — so each
// request carries an id and every line is machine-readable JSON.
//
// THE REDACT LIST IS THE POINT. Without it an access token ends up in plaintext
// in the PM2 logs, which would make the encryption work pointless: a token is a
// token whether it leaks from the database or from a log file.
//
// pino is optional. If it is not installed the module falls back to console,
// so nothing breaks on an environment that has not run `npm i` yet.
//
/**
 * The real console, captured before installConsoleBridge() replaces it.
 * Everything that actually writes must go through these, or bridging console
 * into a logger that writes to console would recurse forever.
 */
const NATIVE_CONSOLE = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: (console.debug || console.log).bind(console),
};

let pino = null;
try {
  ({ default: pino } = await import("pino"));
} catch {
  pino = null;
}

/**
 * Field names that must never be printed.
 *
 * A LESSON FROM A TEST: these used to be written only as `*.access_token`, and
 * a pino wildcard path means "any top-level key, THEN .access_token" — so a
 * token logged as a top-level field was never redacted at all. The old test
 * passed because pino was not installed and it was exercising the console
 * fallback, which redacts by key name at every depth. Each name is now listed
 * twice, bare and wildcarded, so both depths are covered.
 */
const SECRET_FIELDS = [
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "access_token",
  "accessToken",
  "app_secret",
  "appSecret",
  "verify_token",
  "verifyToken",
  "setting_value",
  "key_hash",
  "api_key",
  "apiKey",
  "callback_secret",
  "subscription_key",
];

/**
 * Customer data. A travel insurance log that prints passport numbers is a
 * breach waiting for someone to read it, and the WhatsApp module handles a
 * phone number on every single webhook.
 */
const PII_FIELDS = [
  "passport",
  "passport_or_id",
  "passportOrId",
  "msisdn",
  "phone",
  "phone_number",
  "phoneNumber",
  "waNumber",
  "wa_number",
  "email",
  "date_of_birth",
  "dateOfBirth",
];

const REDACT = [
  'req.headers["x-hub-signature-256"]',
  "req.headers.authorization",
  "req.headers.cookie",
  ...[...SECRET_FIELDS, ...PII_FIELDS].flatMap((f) => [f, `*.${f}`, `*.*.${f}`]),
];

/**
 * Field names whose value must never be printed, whichever logger is in use.
 * pino handles this through `redact`; the console fallback has to do it itself,
 * otherwise "pino is not installed" silently becomes "tokens in the log file".
 */
/** The console fallback redacts by name itself, from the same two lists. */
const SENSITIVE_KEY = new RegExp(
  `^(${[...SECRET_FIELDS, ...PII_FIELDS].map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}|x-hub-signature-256)$`,
  "i"
);

/**
 * Mask personal data embedded in a MESSAGE rather than in a field.
 *
 * Key-based redaction cannot help with `console.log("inbound from", waNumber)`
 * — the number is an argument, not a property — and that exact shape was
 * logging a customer's phone number on every webhook. These patterns are
 * deliberately blunt: a false positive costs a few masked digits in a log line,
 * a false negative is personal data at rest on the server.
 */
export function scrubText(value) {
  if (typeof value !== "string" || !value) return value;
  return value
    // Email addresses, keeping enough to tell two customers apart.
    .replace(/\b([\w.+-])[\w.+-]*@([\w-]+\.[\w.-]+)\b/g, "$1***@$2")
    // Phone numbers and MSISDNs: 8 to 15 digits, optionally grouped by spaces.
    // Hyphens are deliberately NOT a separator here — "AA-2026-000042" is a
    // policy number, not a phone number, and masking it would make the logs
    // useless for the support question they exist to answer.
    .replace(/(?<![\d-])(\+?\d[\d ]{6,18}\d)(?![\d-])/g, (m) => {
      const digits = m.replace(/\D/g, "");
      if (digits.length < 8 || digits.length > 15) return m;
      return `***${digits.slice(-2)}`;
    });
}

function redactDeep(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) out[k] = "[redacted]";
    else if (typeof v === "string") out[k] = scrubText(v);
    else out[k] = redactDeep(v, depth + 1);
  }
  return out;
}

function makeConsoleLogger() {
  const emit = (level, obj, msg) => {
    const fields = typeof obj === "object" && obj !== null ? redactDeep(obj) : {};
    const line = { level, time: new Date().toISOString(), ...fields };
    const text = typeof obj === "string" ? obj : msg || "";
    const fn =
      level === "error" ? NATIVE_CONSOLE.error : level === "warn" ? NATIVE_CONSOLE.warn : NATIVE_CONSOLE.log;
    fn(JSON.stringify({ ...line, msg: scrubText(text) }));
  };
  const l = {
    debug: (o, m) => emit("debug", o, m),
    info: (o, m) => emit("info", o, m),
    warn: (o, m) => emit("warn", o, m),
    error: (o, m) => emit("error", o, m),
    child: () => l,
  };
  return l;
}

/**
 * The one pino configuration. Exported so the tests can build a logger that
 * writes somewhere they can read, with EXACTLY the redaction the server uses —
 * a test that pins a parallel config proves nothing about production.
 */
export const loggerOptions = pino
  ? {
      level: process.env.LOG_LEVEL || "info",
      redact: { paths: REDACT, censor: "[redacted]" },
      base: { service: "assurassistance-api" },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Scrub the message itself. Redaction works on fields; a phone number
      // passed as text — which is how the webhook logged it — is not a field.
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((a) => (typeof a === "string" ? scrubText(a) : a));
          return method.apply(this, scrubbed);
        },
      },
    }
  : null;

/** Build a logger writing to a given destination. Used by the server and tests. */
export function createLogger(destination = null) {
  if (!pino) return makeConsoleLogger();
  return destination ? pino(loggerOptions, destination) : pino(loggerOptions);
}

export const logger = createLogger();

/**
 * Route every `console.*` call in the codebase through the logger.
 *
 * WHY A BRIDGE RATHER THAN 164 EDITS. The backend has 164 bare `console.*`
 * calls across controllers, models and utils. Rewriting each one by hand is a
 * large diff over code that is working, with a real chance of changing
 * behaviour in a money path; and the next one someone writes would bypass the
 * logger again. Replacing the console itself catches all of them, and every
 * future one, with one small change.
 *
 * What each line gains: a timestamp, a level, JSON structure, and — the point —
 * the same redaction and PII scrubbing as a deliberate logger call. Before
 * this, `console.log("inbound from", waNumber)` put a customer's phone number
 * in the PM2 log on every webhook.
 *
 * Call it once, early, from server.js. It is a no-op when pino is not
 * installed, because bridging console into a logger that writes to console
 * would recurse forever.
 */
export function installConsoleBridge() {
  if (!pino) return { installed: false, reason: "pino_not_installed" };
  if (console.__aasBridged) return { installed: true, reason: "already" };

  const toLine = (args) => {
    const parts = [];
    const fields = {};
    for (const arg of args) {
      if (arg instanceof Error) {
        fields.err = { message: scrubText(arg.message), stack: arg.stack };
        parts.push(scrubText(arg.message));
      } else if (arg && typeof arg === "object") {
        Object.assign(fields, redactDeep(arg));
      } else {
        parts.push(scrubText(String(arg)));
      }
    }
    return { msg: parts.join(" ").trim(), fields };
  };

  const bridge = (level) => (...args) => {
    const { msg, fields } = toLine(args);
    logger[level](fields, msg);
  };

  console.log = bridge("info");
  console.info = bridge("info");
  console.warn = bridge("warn");
  console.error = bridge("error");
  console.debug = bridge("debug");
  console.__aasBridged = true;

  return { installed: true };
}

/** Undo the bridge. Only tests need this. */
export function removeConsoleBridge() {
  console.log = NATIVE_CONSOLE.log;
  console.info = NATIVE_CONSOLE.log;
  console.warn = NATIVE_CONSOLE.warn;
  console.error = NATIVE_CONSOLE.error;
  console.debug = NATIVE_CONSOLE.debug;
  delete console.__aasBridged;
}

/** A logger bound to one request, so every line can be traced back to it. */
export function requestLogger(req) {
  return logger.child ? logger.child({ requestId: req?.id || null }) : logger;
}

/** Express middleware: give every request an id and echo it back. */
export function requestIdMiddleware(req, res, next) {
  const incoming = req.headers["x-request-id"];
  req.id = typeof incoming === "string" && incoming.length <= 64
    ? incoming
    : (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  res.setHeader("X-Request-Id", req.id);
  next();
}
