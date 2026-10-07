// src/utils/whatsapp/outbound.js
//
// Sending a message the customer did not just ask for.
//
// Everything the module sent until now was a REPLY: an inbound message arrived,
// the engine produced an answer, the controller flushed it. A payment breaks
// that shape — the provider's callback can land minutes later, and by then
// there is no request to reply to.
//
// Two things make that legal rather than merely possible:
//
//   THE 24-HOUR WINDOW. Meta only allows free-form messages within 24 hours of
//   the customer's last message. Outside it, anything the business starts must
//   be a template approved in WhatsApp Manager. `withinCustomerServiceWindow`
//   and `sendTemplate` were both built in Milestone 2 and called by nothing;
//   this is what calls them.
//
//   NO SILENT DROPS. When the window has closed and no template is configured
//   for that moment, we do not pretend to have sent anything: the caller is told
//   so it can be surfaced rather than leaving a customer who paid in silence.
//
import {
  sendText,
  sendButtons,
  sendList,
  sendTemplate,
  withinCustomerServiceWindow,
} from "./client.js";
import { getLastInboundAt } from "../../models/whatsappModel.js";

/**
 * Deliver one engine reply, choosing free-form or template by the window.
 *
 * @param {object} reply   as the engine produces it: {kind, body, buttons…}
 * @param {object} opts
 * @param {string} opts.waNumber
 * @param {number} opts.sessionId
 * @param {object} opts.config      the WhatsApp runtime config
 * @param {boolean} opts.windowOpen whether free-form is allowed right now
 * @param {string}  [opts.templateName]   approved template to use when it is not
 * @param {string[]} [opts.templateParams] body parameters for that template
 */
export async function deliverOne(reply, { waNumber, sessionId, config, windowOpen, templateName, templateParams = [] }) {
  if (windowOpen) {
    if (reply.kind === "buttons") {
      return sendButtons({
        to: waNumber, body: reply.body, buttons: reply.buttons,
        sessionId, stepKey: reply.stepKey, config,
      });
    }
    if (reply.kind === "list") {
      return sendList({
        to: waNumber, body: reply.body, sections: reply.sections,
        buttonText: reply.buttonText, sessionId, stepKey: reply.stepKey, config,
      });
    }
    return sendText({ to: waNumber, text: reply.body, sessionId, stepKey: reply.stepKey, config });
  }

  // Outside the window. A template is the only thing Meta will deliver, and an
  // interactive message cannot be sent as one at all.
  if (!templateName) {
    return {
      ok: false,
      code: "window_closed_no_template",
      message:
        "The 24-hour customer-service window has closed and no approved template is configured for this message",
    };
  }

  return sendTemplate({
    to: waNumber,
    templateName,
    languageCode: config?.templateLanguage || "fr",
    bodyParams: templateParams,
    sessionId,
    stepKey: reply.stepKey,
    config,
  });
}

/**
 * Deliver a set of replies to a conversation that is not currently answering us.
 *
 * Returns what happened per reply rather than throwing: a payment has already
 * been taken by the time this runs, so a delivery failure must be recorded and
 * surfaced, never allowed to unwind the transaction.
 */
export async function deliverToSession({ session, replies, config, templateName, templateParams = [] }) {
  const lastInbound = await getLastInboundAt(session.id);
  const windowOpen = withinCustomerServiceWindow(lastInbound);

  const results = [];
  for (const reply of replies) {
    try {
      const result = await deliverOne(reply, {
        waNumber: session.waNumber,
        sessionId: session.id,
        config,
        windowOpen,
        // Only the first message of a batch can be a template; the rest would
        // ride inside the window that first one does NOT open. Meta reopens the
        // window on a customer reply, not on our template.
        templateName: results.length === 0 ? templateName : null,
        templateParams,
      });
      results.push({ ok: Boolean(result?.ok), code: result?.code || null, message: result?.message || null });
    } catch (err) {
      results.push({ ok: false, code: "send_threw", message: err.message });
    }
  }

  return {
    windowOpen,
    delivered: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok),
    results,
  };
}

export const __testables = { deliverOne };
