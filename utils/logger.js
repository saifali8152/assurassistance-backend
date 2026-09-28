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
let pino = null;
try {
  ({ default: pino } = await import("pino"));
} catch {
  pino = null;
}

const REDACT = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-hub-signature-256"]',
  "*.access_token",
  "*.accessToken",
  "*.app_secret",
  "*.appSecret",
  "*.verify_token",
  "*.verifyToken",
  "*.password",
  "*.setting_value",
  "*.key_hash",
  "*.secret",
];

/**
 * Field names whose value must never be printed, whichever logger is in use.
 * pino handles this through `redact`; the console fallback has to do it itself,
 * otherwise "pino is not installed" silently becomes "tokens in the log file".
 */
const SENSITIVE_KEY = /^(authorization|cookie|x-hub-signature-256|password|secret|access_?token|app_?secret|verify_?token|setting_value|key_hash|token)$/i;

function redactDeep(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redactDeep(v, depth + 1);
  }
  return out;
}

function makeConsoleLogger() {
  const emit = (level, obj, msg) => {
    const fields = typeof obj === "object" && obj !== null ? redactDeep(obj) : {};
    const line = { level, time: new Date().toISOString(), ...fields };
    const text = typeof obj === "string" ? obj : msg || "";
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(JSON.stringify({ ...line, msg: text }));
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

export const logger = pino
  ? pino({
      level: process.env.LOG_LEVEL || "info",
      redact: { paths: REDACT, censor: "[redacted]" },
      base: { service: "assurassistance-api" },
      timestamp: pino.stdTimeFunctions.isoTime,
    })
  : makeConsoleLogger();

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
