// src/utils/whatsapp/parser.js
//
// Normalising Meta's webhook payload into something the engine can act on.
//
// Meta's shape is deeply nested and every level is optional:
//   { entry: [ { changes: [ { value: { messages: [...], statuses: [...] } } ] } ] }
//
// It also mixes three unrelated things into one POST — customer messages,
// delivery receipts, and errors — so the parser separates them. Anything we do
// not understand is returned as type "unsupported" rather than dropped, so the
// conversation can answer politely instead of going silent.
//
const TEXTUAL_TYPES = new Set(["text", "button", "interactive"]);

/**
 * @returns {{messages: object[], statuses: object[], errors: object[], contacts: object[]}}
 */
export function parseWebhookPayload(payload) {
  const out = { messages: [], statuses: [], errors: [], contacts: [] };
  if (!payload || typeof payload !== "object") return out;

  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value || {};
      const metadata = value.metadata || {};
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];

      for (const c of contacts) {
        out.contacts.push({ waId: c?.wa_id || null, profileName: c?.profile?.name || null });
      }

      for (const m of Array.isArray(value.messages) ? value.messages : []) {
        out.messages.push(normaliseMessage(m, { metadata, contacts }));
      }
      for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
        out.statuses.push(normaliseStatus(s));
      }
      for (const e of Array.isArray(value.errors) ? value.errors : []) {
        out.errors.push({ code: e?.code ?? null, title: e?.title || null, message: e?.message || null });
      }
    }
  }
  return out;
}

function normaliseMessage(m, { metadata, contacts }) {
  const from = m?.from || null;
  const contact = contacts.find((c) => c?.wa_id === from);

  const base = {
    waMessageId: m?.id || null,
    from,
    profileName: contact?.profile?.name || null,
    timestamp: m?.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
    phoneNumberId: metadata?.phone_number_id || null,
    rawType: m?.type || "unknown",
    type: "unsupported",
    text: null,
    /** Set when the customer tapped a button or picked a list row. */
    selectionId: null,
    selectionTitle: null,
    raw: m,
  };

  switch (m?.type) {
    case "text":
      return { ...base, type: "text", text: (m.text?.body ?? "").trim() };

    case "interactive": {
      const i = m.interactive || {};
      if (i.type === "button_reply") {
        return {
          ...base,
          type: "selection",
          selectionId: i.button_reply?.id || null,
          selectionTitle: i.button_reply?.title || null,
          text: i.button_reply?.title || null,
        };
      }
      if (i.type === "list_reply") {
        return {
          ...base,
          type: "selection",
          selectionId: i.list_reply?.id || null,
          selectionTitle: i.list_reply?.title || null,
          text: i.list_reply?.title || null,
        };
      }
      // nfm_reply (Flows) and anything else Meta adds later.
      return { ...base, type: "unsupported", text: null };
    }

    // Reply to a pre-Cloud-API style template button.
    case "button":
      return {
        ...base,
        type: "selection",
        selectionId: m.button?.payload || null,
        selectionTitle: m.button?.text || null,
        text: m.button?.text || null,
      };

    case "image":
    case "video":
    case "audio":
    case "voice":
    case "document":
    case "sticker":
    case "location":
    case "contacts":
      return { ...base, type: "unsupported", unsupportedKind: m.type };

    case "system":
      return { ...base, type: "system", text: m.system?.body || null };

    // Meta reports undeliverable inbound content (e.g. an unsupported message)
    // as a message carrying errors.
    case "unsupported":
      return { ...base, type: "unsupported", unsupportedKind: "unsupported" };

    default:
      return base;
  }
}

function normaliseStatus(s) {
  const error = Array.isArray(s?.errors) ? s.errors[0] : null;
  return {
    waMessageId: s?.id || null,
    recipient: s?.recipient_id || null,
    status: s?.status || null, // sent | delivered | read | failed
    timestamp: s?.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date(),
    errorCode: error?.code ?? null,
    errorMessage: error?.message || error?.title || null,
  };
}

/** Did this payload contain anything the engine should act on? */
export function hasActionableContent(parsed) {
  return Boolean(parsed?.messages?.length);
}

export function isTextual(message) {
  return TEXTUAL_TYPES.has(message?.rawType);
}
