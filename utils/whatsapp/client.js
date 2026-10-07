// src/utils/whatsapp/client.js
//
// Outbound messaging through Meta's Graph API.
//
// RESPONSIBILITIES
//   * Build the three message shapes the flow uses: plain text, reply buttons
//     (max 3) and list pickers (max 10 rows).
//   * Enforce Meta's limits BEFORE sending, because a rejected send costs the
//     customer a silent gap in the conversation. Titles are truncated rather
//     than rejected — a shortened country name is better than no reply.
//   * Retry transient failures with exponential backoff, and never retry a
//     permanent one (a bad token or an invalid recipient will fail identically
//     three times and just delay the customer).
//   * Archive every attempt through whatsappModel, so support can see exactly
//     what the customer was shown.
//
import { getWhatsAppConfig } from "../appSettings.js";
import { recordOutboundMessage, markOutboundSent, markOutboundFailed } from "../../models/whatsappModel.js";

/** Meta's documented limits. */
export const LIMITS = {
  bodyText: 4096,
  buttonCount: 3,
  buttonTitle: 20,
  listRows: 10,
  listRowTitle: 24,
  listRowDescription: 72,
  listButtonText: 20,
  listSectionTitle: 24,
  headerText: 60,
  footerText: 60,
};

const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;
const REQUEST_TIMEOUT_MS = 12_000;

export function truncate(s, max) {
  const str = String(s ?? "");
  if (str.length <= max) return str;
  // Keep it readable: cut at the last space inside the budget where possible.
  const hard = str.slice(0, max - 1);
  const lastSpace = hard.lastIndexOf(" ");
  return `${lastSpace > max * 0.6 ? hard.slice(0, lastSpace) : hard}…`;
}

/* ------------------------------------------------------- payload builders */

export function buildTextPayload(to, text, { previewUrl = false } = {}) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: Boolean(previewUrl), body: truncate(text, LIMITS.bodyText) },
  };
}

/**
 * @param {{id: string, title: string}[]} buttons at most 3; extras are dropped
 * and the caller is expected to have offered a list instead.
 */
export function buildButtonsPayload(to, body, buttons, { header = null, footer = null } = {}) {
  const trimmed = (buttons || []).slice(0, LIMITS.buttonCount).map((b) => ({
    type: "reply",
    reply: { id: String(b.id).slice(0, 256), title: truncate(b.title, LIMITS.buttonTitle) },
  }));

  const interactive = {
    type: "button",
    body: { text: truncate(body, LIMITS.bodyText) },
    action: { buttons: trimmed },
  };
  if (header) interactive.header = { type: "text", text: truncate(header, LIMITS.headerText) };
  if (footer) interactive.footer = { text: truncate(footer, LIMITS.footerText) };

  return { messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive", interactive };
}

/**
 * @param {{title?: string, rows: {id: string, title: string, description?: string}[]}[]} sections
 * Total rows across all sections must not exceed 10 — extras are dropped here so
 * Meta never rejects the message.
 */
export function buildListPayload(to, body, sections, { buttonText = "Choose", header = null, footer = null } = {}) {
  let budget = LIMITS.listRows;
  const safeSections = [];

  for (const section of sections || []) {
    if (budget <= 0) break;
    const rows = (section.rows || []).slice(0, budget).map((r) => {
      const row = { id: String(r.id).slice(0, 200), title: truncate(r.title, LIMITS.listRowTitle) };
      if (r.description) row.description = truncate(r.description, LIMITS.listRowDescription);
      return row;
    });
    if (!rows.length) continue;
    budget -= rows.length;
    const s = { rows };
    if (section.title) s.title = truncate(section.title, LIMITS.listSectionTitle);
    safeSections.push(s);
  }

  const interactive = {
    type: "list",
    body: { text: truncate(body, LIMITS.bodyText) },
    action: { button: truncate(buttonText, LIMITS.listButtonText), sections: safeSections },
  };
  if (header) interactive.header = { type: "text", text: truncate(header, LIMITS.headerText) };
  if (footer) interactive.footer = { text: truncate(footer, LIMITS.footerText) };

  return { messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive", interactive };
}

/** Mark the customer's message as read — the "seen" ticks, so the wait feels answered. */
export function buildReadReceiptPayload(waMessageId) {
  return { messaging_product: "whatsapp", status: "read", message_id: waMessageId };
}

/* ------------------------------------------------------------ transport */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST to the Graph API with retry/backoff.
 * @returns {{ok: true, waMessageId: string|null, response: object}
 *          | {ok: false, code: string, message: string, status?: number, retryable: boolean}}
 */
export async function graphSend(payload, { config = null } = {}) {
  const cfg = config || (await getWhatsAppConfig());
  if (!cfg.accessToken || !cfg.phoneNumberId) {
    return { ok: false, code: "not_configured", message: "WhatsApp credentials are not configured", retryable: false };
  }

  const url = `https://graph.facebook.com/${cfg.apiVersion}/${encodeURIComponent(cfg.phoneNumberId)}/messages`;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const body = await response.json().catch(() => ({}));

      if (response.ok) {
        return { ok: true, waMessageId: body?.messages?.[0]?.id || null, response: body };
      }

      const metaError = body?.error || {};
      const retryable = RETRYABLE_HTTP.has(response.status);
      lastError = {
        ok: false,
        code: String(metaError.code ?? response.status),
        message: metaError.message || `Meta returned HTTP ${response.status}`,
        status: response.status,
        retryable,
      };
      if (!retryable) return lastError;
    } catch (err) {
      clearTimeout(timer);
      lastError = {
        ok: false,
        code: err.name === "AbortError" ? "timeout" : "network_error",
        message: err.message || "Request to Meta failed",
        retryable: true,
      };
    }

    if (attempt < MAX_ATTEMPTS) {
      // 400ms, 800ms — with jitter so retries from several workers don't align.
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 150));
    }
  }

  return lastError || { ok: false, code: "unknown", message: "Send failed", retryable: false };
}

/* --------------------------------------------------- archived send helpers */

/**
 * Send and archive in one call. The message row is written BEFORE the send, so a
 * crash mid-send still leaves a trace of what we intended to say.
 */
export async function sendAndLog({ to, payload, sessionId = null, stepKey = null, bodyText = null, messageType = "text", config = null }) {
  const logId = await recordOutboundMessage({
    sessionId,
    waNumber: to,
    messageType,
    body: bodyText,
    payload,
    stepKey,
    status: "queued",
  });

  const result = await graphSend(payload, { config });

  if (result.ok) {
    await markOutboundSent(logId, result.waMessageId);
    return { ok: true, logId, waMessageId: result.waMessageId };
  }
  await markOutboundFailed(logId, result.code, result.message);
  return { ok: false, logId, code: result.code, message: result.message };
}

/**
 * A document message — the certificate.
 *
 * Meta takes either an uploaded media id or a public https link. We send a
 * link: uploading would need a multipart POST that graphSend (JSON only) cannot
 * do, and the certificate already has a token-gated public URL for the QR code,
 * so there is nothing new to expose.
 *
 * The link must be reachable by Meta's servers, not just by the customer, and
 * must be https. A localhost or private address silently fails at Meta's end.
 */
export function buildDocumentPayload(to, { link, filename, caption = null }) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "document",
    document: {
      link,
      filename: truncate(String(filename || "document.pdf"), 240),
      ...(caption ? { caption: truncate(String(caption), LIMITS.bodyText) } : {}),
    },
  };
}

export async function sendDocument({ to, link, filename, caption = null, sessionId = null, stepKey = null, config = null }) {
  if (!/^https:\/\//i.test(String(link || ""))) {
    // Fail loudly rather than letting Meta reject it with an opaque code: a
    // certificate that silently never arrives is the worst failure here.
    return { ok: false, code: "invalid_document_link", message: "A document link must be an absolute https URL" };
  }
  return sendAndLog({
    to,
    payload: buildDocumentPayload(to, { link, filename, caption }),
    sessionId,
    stepKey,
    bodyText: caption || filename || "document",
    messageType: "document",
    config,
  });
}

export async function sendText({ to, text, sessionId = null, stepKey = null, config = null }) {
  return sendAndLog({
    to,
    payload: buildTextPayload(to, text),
    sessionId,
    stepKey,
    bodyText: text,
    messageType: "text",
    config,
  });
}

export async function sendButtons({ to, body, buttons, header = null, footer = null, sessionId = null, stepKey = null, config = null }) {
  return sendAndLog({
    to,
    payload: buildButtonsPayload(to, body, buttons, { header, footer }),
    sessionId,
    stepKey,
    bodyText: body,
    messageType: "buttons",
    config,
  });
}

export async function sendList({ to, body, sections, buttonText = "Choose", header = null, footer = null, sessionId = null, stepKey = null, config = null }) {
  return sendAndLog({
    to,
    payload: buildListPayload(to, body, sections, { buttonText, header, footer }),
    sessionId,
    stepKey,
    bodyText: body,
    messageType: "list",
    config,
  });
}

/** Read receipts are cosmetic: failures are swallowed and never archived. */
export async function markRead(waMessageId, { config = null } = {}) {
  if (!waMessageId) return;
  await graphSend(buildReadReceiptPayload(waMessageId), { config }).catch(() => {});
}

/* ------------------------------------------------------- template messages */

/**
 * Templates exist because of Meta's 24-hour customer-service window.
 *
 * Inside 24 hours of a customer's last message we may send anything — that is
 * what the whole purchase conversation relies on. OUTSIDE it, free-form text is
 * rejected, and only a template Meta has pre-approved will deliver. So every
 * message we START — "payment received", "your certificate is ready", a
 * follow-up on an abandoned quote — has to be a template.
 *
 * Approval takes 24–48h on Meta's side, so templates are submitted well before
 * the code that uses them ships.
 *
 * `components` follows Meta's own shape. The common case is positional body
 * variables:
 *
 *   componentsFromBodyParams(["Saif", "QT-BF664C18"])
 *   -> [{ type: "body", parameters: [{type:"text",text:"Saif"}, …] }]
 */
export function buildTemplatePayload(to, templateName, languageCode = "fr", components = []) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: String(templateName),
      // Meta wants a locale code; "fr" and "en" are accepted, as are fr_FR/en_GB.
      language: { code: String(languageCode || "fr") },
      ...(components.length ? { components } : {}),
    },
  };
}

/** Positional {{1}}, {{2}}… body variables, in order. */
export function componentsFromBodyParams(params = []) {
  if (!params.length) return [];
  return [
    {
      type: "body",
      parameters: params.map((p) => ({ type: "text", text: truncate(String(p ?? ""), 1024) })),
    },
  ];
}

/**
 * Send a pre-approved template.
 *
 * Archived like any other outbound message, with the template name recorded in
 * the body so support can see WHICH template a customer received — the rendered
 * text lives on Meta's side, not ours.
 */
export async function sendTemplate({
  to,
  templateName,
  languageCode = "fr",
  bodyParams = [],
  components = null,
  sessionId = null,
  stepKey = null,
  config = null,
}) {
  const resolved = components || componentsFromBodyParams(bodyParams);
  return sendAndLog({
    to,
    payload: buildTemplatePayload(to, templateName, languageCode, resolved),
    sessionId,
    stepKey,
    bodyText: `[template:${templateName}:${languageCode}] ${bodyParams.join(" | ")}`.trim(),
    messageType: "template",
    config,
  });
}

/**
 * Is a free-form reply still allowed?
 *
 * Meta's window runs 24 hours from the customer's last INBOUND message. Callers
 * that may be running long after a conversation (a payment webhook, a nightly
 * job) should check this and fall back to a template rather than discovering the
 * limit through a failed send.
 */
export function withinCustomerServiceWindow(lastInboundAt, { now = new Date(), hours = 24 } = {}) {
  if (!lastInboundAt) return false;
  const last = lastInboundAt instanceof Date ? lastInboundAt : new Date(lastInboundAt);
  if (Number.isNaN(last.getTime())) return false;
  return now.getTime() - last.getTime() < hours * 3600 * 1000;
}
