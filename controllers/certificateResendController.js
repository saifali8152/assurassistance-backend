// controllers/certificateResendController.js
//
// Milestone 5, Day 10 — "Re-send certificate on WhatsApp" from the policy
// screen. Goes through deliverCertificate(), the same path a confirmed payment
// and the customer's own ATTESTATION request use, so the 24-hour window, the
// template fallback and the size guard behave identically.
//
// Until the WhatsApp number is connected (Meta not live yet) it answers 409
// with a clear reason instead of pretending to send.
//
import getPool from "../utils/db.js";
import { getWhatsAppConfig } from "../utils/appSettings.js";
import { deliverCertificate } from "../utils/payments/service.js";
import { logAudit } from "../utils/adminAudit.js";
import { validatePhoneE164 } from "../utils/validators.js";

const REASONS = {
  no_certificate: "This policy has no certificate yet",
  no_public_token: "The certificate has no public link",
  no_public_base_url: "PUBLIC_API_URL is not set on the server",
  window_closed_no_template: "The customer has not written in the last 24 hours and no 'certificate ready' template is configured",
};

export const resendCertificateWhatsApp = async (req, res) => {
  try {
    const saleId = Number(req.params.id);
    const config = await getWhatsAppConfig();
    if (!config.ready) {
      return res.status(409).json({ ok: false, code: "whatsapp_not_ready", message: "WhatsApp is not connected yet", missing: config.missing });
    }
    const [[sale]] = await getPool().query(
      `SELECT s.id, s.policy_number, s.deleted_at, t.whatsapp_number, t.phone, t.preferred_language
         FROM sales s JOIN cases c ON c.id = s.case_id JOIN travellers t ON t.id = c.traveller_id
        WHERE s.id = ? LIMIT 1`,
      [saleId]
    );
    if (!sale) return res.status(404).json({ ok: false, code: "not_found", message: "Policy not found" });

    // Staff may type another number (the customer changed phones); otherwise
    // the traveller's WhatsApp number, then their phone.
    const typed = req.body?.waNumber ? validatePhoneE164(String(req.body.waNumber)) : null;
    if (typed && !typed.ok) return res.status(400).json({ ok: false, code: "invalid_number", message: "Enter the number with its country code" });
    const target = String(typed?.value || sale.whatsapp_number || sale.phone || "").replace(/\D/g, "");
    if (target.length < 8) return res.status(400).json({ ok: false, code: "no_number", message: "This policy has no WhatsApp number; enter one" });

    const [[session]] = await getPool().query(
      `SELECT id, wa_number, language, quote_reference FROM whatsapp_sessions WHERE wa_number = ? ORDER BY updated_at DESC LIMIT 1`,
      [target]
    );
    const outcome = await deliverCertificate({
      session: {
        id: session?.id ?? null,
        waNumber: target,
        language: session?.language || sale.preferred_language || "fr",
        quoteReference: session?.quote_reference || null,
      },
      saleId,
      policyNumber: sale.policy_number,
      config,
    });
    await logAudit(req, "certificate.resend_whatsapp", { entity: "sale", entityId: saleId, detail: { ok: Boolean(outcome?.ok), reason: outcome?.reason || null, last4: target.slice(-4) } });
    if (!outcome?.ok) {
      return res.status(502).json({ ok: false, code: outcome?.reason || "send_failed", message: REASONS[outcome?.reason] || "WhatsApp did not accept the message" });
    }
    return res.json({ ok: true, via: outcome.reason === "sent_as_template" ? "template" : outcome.fallback ? "link" : "document", to: `••••${target.slice(-4)}` });
  } catch (err) {
    console.error("resend certificate:", err);
    return res.status(500).json({ ok: false, code: "server_error", message: "Server error" });
  }
};
