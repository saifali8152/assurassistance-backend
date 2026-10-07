// src/utils/payments/service.js
//
// The orchestration between a conversation and a payment.
//
// The engine stays pure — it returns replies and a patch and touches nothing —
// so everything that has side effects lives here: creating the transaction,
// calling the provider, and later waking the parked conversation when the
// provider answers.
//
// THE WAKE-UP IS THE POINT. `processMessage` cannot run without an inbound
// message, and a callback arriving four minutes later has none. `resumeAfterPayment`
// is the engine's event-driven entry point; this module is what drives it and
// flushes the result through the outbound sender, which knows about Meta's
// 24-hour window.
//
import { getProviderConfig, getPaymentConfig } from "./config.js";
import { getProvider } from "./index.js";
import { normaliseResult } from "./provider.js";
import {
  createTransaction,
  getTransactionById,
  setProviderTxId,
  transition,
} from "../../models/paymentModel.js";
import { getSessionById, updateSession } from "../../models/whatsappModel.js";
import { resumeAfterPayment } from "../whatsapp/engine.js";
import { deliverToSession } from "../whatsapp/outbound.js";
import { getWhatsAppConfig } from "../appSettings.js";
import { getCertificateBySaleId, ensureCertificatePublicToken } from "../../models/certificateModel.js";
import { getLastInboundAt } from "../../models/whatsappModel.js";
import { sendDocument, sendText, sendTemplate, withinCustomerServiceWindow } from "../whatsapp/client.js";
// The certificate payload builder lives in the document controller, and the one
// store-aware renderer with it. Importing it here keeps a single rendering path
// for the admin download, the public link and this delivery; moving the builder
// into a utility is a refactor of its own and would not change behaviour.
import { certificateDocumentSize } from "../../controllers/documentController.js";
import { MAX_DOCUMENT_BYTES } from "../certificateStore.js";
import { notifyOps } from "../alerts.js";
import { formatMoney } from "../quoteEngine.js";
import { captureException } from "../monitoring.js";
import { getCaseDetailsById, updateCaseStatus } from "../../models/caseModel.js";
import { issuePolicy } from "../../models/policyIssuance.js";
import { attachSale } from "../../models/paymentModel.js";
import { computePremiumForCaseDetails } from "../recomputeSalePremium.js";

/** Absolute URL a provider should call back on. */
export function callbackUrlFor(providerCode) {
  const base = (process.env.PUBLIC_API_URL || process.env.BASE_URL || "").replace(/\/+$/, "");
  const path = `/api/payments/webhook/${providerCode}`;
  return base ? `${base}${path}` : path;
}

/**
 * The operators this customer may use, for the engine's provider step.
 *
 * Returns only what the engine needs — code, label, prefixes — never the
 * credentials, so a bug in the conversation layer cannot leak one.
 */
export async function paymentOptionsFor(countryCode) {
  const cfg = await getPaymentConfig();
  if (!cfg.enabled) return { enabled: false, options: [] };
  const want = String(countryCode || "").trim().toUpperCase();
  const options = cfg.providers
    .filter((p) => p.ready && (!want || p.countries.includes(want)))
    .map((p) => ({ code: p.code, label: p.label, msisdnPrefixes: p.msisdnPrefixes }));
  return { enabled: true, options, currency: cfg.currency, timeoutMinutes: cfg.timeoutMinutes };
}

/**
 * Create the transaction and ask the provider to prompt the customer.
 *
 * Injected into the engine as `deps.startPayment`. Returns the shape the engine
 * expects: either ok with what to tell the customer, or a failure code it has
 * wording for in both languages.
 */
export async function startPaymentForSession({ session, collectedData }) {
  const data = collectedData || {};
  const providerCode = data.payment_provider;
  const msisdn = data.payment_msisdn;

  const cfg = await getProviderConfig(providerCode);
  const provider = getProvider(providerCode);
  if (!cfg || !cfg.ready || !provider) {
    return { ok: false, failureCode: "configuration_error" };
  }

  const amount = Number(data.premium);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, failureCode: "configuration_error" };
  }
  const currency = data.currency || cfg.currency || "XOF";
  const payCfg = await getPaymentConfig();

  // One key per ATTEMPT, not per session: a retry after a failure is a new
  // payment and must not be deduplicated against the one that failed.
  const attempt = (session.collectedData?.__payAttempt || 0) + 1;
  const idempotencyKey = `wa:${session.id}:${providerCode}:${msisdn}:${attempt}`;

  let created;
  try {
    created = await createTransaction({
      caseId: session.caseId || null,
      provider: providerCode,
      idempotencyKey,
      msisdn,
      amount,
      currency,
      waSessionId: session.id,
      timeoutMinutes: payCfg.timeoutMinutes,
    });
  } catch (err) {
    captureException(err, { scope: "payment_create", provider: providerCode });
    return { ok: false, failureCode: "unknown" };
  }

  const tx = created.transaction;

  // Park the conversation on this transaction before calling out, so a callback
  // that beats the response still finds the session to wake.
  await updateSession(session.id, { paymentTransactionId: tx.id }).catch(() => {});

  let result;
  try {
    result = normaliseResult(
      await provider.initiatePayment({
        reference: tx.reference,
        amount,
        currency,
        msisdn,
        description: `Assur'Assistance ${data.plan_name || ""}`.trim(),
        callbackUrl: callbackUrlFor(providerCode),
        config: cfg,
      }),
      providerCode
    );
  } catch (err) {
    captureException(err, { scope: "payment_initiate", provider: providerCode });
    await transition(tx.id, "failed", {
      by: "system",
      failureCode: "provider_unavailable",
      failureDetail: err.message,
    }).catch(() => {});
    return { ok: false, failureCode: "provider_unavailable" };
  }

  if (result.providerTxId) await setProviderTxId(tx.id, result.providerTxId).catch(() => {});

  if (!result.ok) {
    await transition(tx.id, "failed", {
      by: `provider:${providerCode}`,
      failureCode: result.failureCode || "provider_rejected",
      failureDetail: result.failureDetail || null,
    }).catch(() => {});
    return { ok: false, failureCode: result.failureCode || "provider_rejected" };
  }

  await transition(tx.id, "initiated", { by: "system" }).catch(() => {});
  if (result.status === "awaiting_confirmation") {
    await transition(tx.id, "awaiting_confirmation", { by: `provider:${providerCode}` }).catch(() => {});
  }

  return {
    ok: true,
    transactionId: tx.id,
    reference: tx.reference,
    amountText: formatMoney(amount, currency, session.language || "fr"),
    customerHint: result.customerHint || null,
    attempt,
  };
}

/**
 * Turn a confirmed payment into a policy.
 *
 * Called only from a REAL transition to `completed` — never from initiation,
 * and never from a repeated callback. Issuance itself is idempotent (one live
 * sale per case, enforced by the database), so even if that guarantee were
 * broken upstream the customer could not end up with two policies.
 */
export async function issuePolicyForTransaction(tx) {
  if (!tx?.case_id) return { ok: false, reason: "no_case" };

  const caseRow = await getCaseDetailsById(tx.case_id);
  if (!caseRow) return { ok: false, reason: "case_gone" };

  // Price from the case rather than trusting the amount on the transaction: the
  // transaction records what was CHARGED, the case is what was SOLD, and a
  // mismatch is something to notice rather than paper over.
  const priced = computePremiumForCaseDetails(caseRow);
  if (!priced?.ok) return { ok: false, reason: "not_priceable", detail: priced?.error };

  const charged = Number(tx.amount);
  if (Number.isFinite(charged) && Math.abs(charged - Number(priced.total)) > 0.5) {
    captureException(new Error("Payment amount does not match the policy price"), {
      scope: "payment_amount_mismatch",
      reference: tx.reference,
      charged,
      priced: priced.total,
    });
  }

  const issued = await issuePolicy({
    caseId: tx.case_id,
    caseRow,
    pricing: {
      premium: priced.premium,
      tax: priced.tax || 0,
      total: priced.total,
      currency: tx.currency || caseRow.currency || "XOF",
      validityDays: priced.validityDays ?? null,
      ageBand: priced.ageBand ?? null,
    },
    paid: { method: tx.provider, reference: tx.reference, amount: charged },
  });

  await attachSale(tx.id, issued.saleId).catch(() => {});

  // Nothing used to move a case out of AwaitingPayment, so WhatsApp quotes
  // accumulated there with no sale. Paying for one is exactly what confirms it.
  await updateCaseStatus(tx.case_id, "Confirmed").catch(() => {});

  return { ok: true, ...issued };
}

/** Absolute, Meta-fetchable URL for a certificate PDF. */
export function certificateLinkFor(token, language = "fr") {
  const base = (process.env.PUBLIC_API_URL || process.env.BASE_URL || "").replace(/\/+$/, "");
  return base ? `${base}/api/sales/certificate/public/${token}/pdf?lang=${language}` : null;
}

/**
 * Send the certificate into the conversation as a document.
 *
 * WhatsApp fetches the link from META's servers, not the customer's phone, so
 * it has to be public and https — which is why it uses the same token the QR
 * code already exposes rather than anything new.
 *
 * Outside the 24-hour window a document cannot be sent at all; only an approved
 * template can. That is exactly what `whatsapp.template_certificate_ready`
 * exists for, and the customer's reply reopens the window.
 */
export async function deliverCertificate({ session, saleId, policyNumber, config }) {
  try {
    const cert = await getCertificateBySaleId(saleId);
    if (!cert) return { ok: false, reason: "no_certificate" };

    const token = cert.public_token || (await ensureCertificatePublicToken(cert.id));
    if (!token) return { ok: false, reason: "no_public_token" };

    const language = session.language === "en" ? "en" : "fr";
    const link = certificateLinkFor(token, language);
    if (!link) return { ok: false, reason: "no_public_base_url" };

    const lastInbound = await getLastInboundAt(session.id);
    if (!withinCustomerServiceWindow(lastInbound)) {
      const templateName = config.templateCertificateReady;
      if (!templateName) return { ok: false, reason: "window_closed_no_template" };
      const sent = await sendTemplate({
        to: session.waNumber,
        templateName,
        languageCode: config.templateLanguage || language,
        bodyParams: [policyNumber || session.quoteReference || ""],
        sessionId: session.id,
        stepKey: "certificate",
        config,
      });
      return { ok: Boolean(sent?.ok), reason: sent?.ok ? "sent_as_template" : sent?.code, pending: true };
    }

    const filename = `${cert.certificate_number || policyNumber || "attestation"}.pdf`;
    const caption = language === "fr" ? "Votre attestation d'assurance" : "Your insurance certificate";

    // Meta refuses a document over its size limit, and what the customer
    // experiences is simply nothing arriving. Our certificates are around 100 KB
    // against a 100 MB limit, so this is a guard against the future — a very
    // large partner logo, a multi-page attestation — not against today. Measuring
    // is free once the file is stored, which it is for everything issued since the
    // snapshot change; for an older certificate it costs one render. An oversized
    // document degrades to the link, which always works.
    const sized = await certificateDocumentSize(saleId, { locale: language }).catch(() => null);
    if (sized?.bytes && sized.bytes > MAX_DOCUMENT_BYTES) {
      await notifyOps("certificate_too_large", "A certificate PDF is too large to send on WhatsApp", {
        saleId,
        policyNumber,
        bytes: sized.bytes,
        limit: MAX_DOCUMENT_BYTES,
      }).catch(() => {});
      const asLink = await sendText({
        to: session.waNumber,
        text: `${caption}: ${link}`,
        sessionId: session.id,
        stepKey: "certificate",
        config,
      });
      return {
        ok: Boolean(asLink?.ok),
        reason: "document_too_large",
        fallback: true,
        link,
        bytes: sized.bytes,
      };
    }

    const sent = await sendDocument({
      to: session.waNumber,
      link,
      filename,
      caption,
      sessionId: session.id,
      stepKey: "certificate",
      config,
    });

    if (sent?.ok) return { ok: true, link };

    // The document failed — a bad link, a Meta hiccup. Send the link as text
    // rather than leaving a paying customer with nothing.
    const fallback = await sendText({
      to: session.waNumber,
      text: `${caption}: ${link}`,
      sessionId: session.id,
      stepKey: "certificate",
      config,
    });
    return { ok: Boolean(fallback?.ok), reason: sent?.code || "document_failed", fallback: true, link };
  } catch (err) {
    captureException(err, { scope: "payment_deliver_certificate", saleId });
    return { ok: false, reason: "threw", message: err.message };
  }
}

/**
 * Everything that happens when a payment reaches a terminal state.
 *
 * One entry point for the webhook, the status poller and the expiry sweeper, so
 * the order is the same whoever noticed first: issue the policy, then tell the
 * customer, with the policy number in the message.
 */
export async function settlePayment({ transactionId, status, failureCode = null }) {
  let policyNumber = null;

  if (status === "completed") {
    try {
      const tx = await getTransactionById(transactionId);
      const issued = await issuePolicyForTransaction(tx);
      if (issued.ok) policyNumber = issued.policyNumber;
      else captureException(new Error(`Could not issue a policy: ${issued.reason}`), {
        scope: "payment_issue_policy",
        transactionId,
        detail: issued.detail || null,
      });
    } catch (err) {
      // The money has arrived. A failure here must be loud and must NOT stop us
      // telling the customer their payment went through.
      captureException(err, { scope: "payment_issue_policy", transactionId });
    }
  }

  const notice = await notifyConversation({ transactionId, status, failureCode, policyNumber });

  // The certificate follows the confirmation, in that order: the customer is
  // told the payment worked before a document arrives, which is how a person
  // reads it.
  let certificate = null;
  if (status === "completed" && notice?.session && notice?.saleId) {
    certificate = await deliverCertificate({
      session: notice.session,
      saleId: notice.saleId,
      policyNumber,
      config: notice.config,
    });
  }

  return { policyNumber, notice, certificate };
}

/**
 * Wake the conversation parked on a transaction.
 *
 * Called from the webhook once a transition actually happened, and from the
 * expiry sweeper. Safe to call when there is no session — an API-initiated
 * payment has none — and it never throws: by the time this runs the money has
 * already moved, so a messaging failure must be recorded, not propagated.
 */
export async function notifyConversation({ transactionId, status, failureCode = null, policyNumber = null }) {
  try {
    const tx = await getTransactionById(transactionId);
    if (!tx?.wa_session_id) return { notified: false, reason: "no_session" };

    const session = await getSessionById(tx.wa_session_id);
    if (!session) return { notified: false, reason: "session_gone" };
    if (["cancelled", "expired"].includes(session.status)) {
      return { notified: false, reason: `session_${session.status}` };
    }

    const config = await getWhatsAppConfig();
    if (!config.ready) return { notified: false, reason: "whatsapp_not_ready" };

    const { enabled, options } = await paymentOptionsFor(
      session.collectedData?.residence_code || session.collectedData?.nationality_code
    );

    const outcome = { status, failureCode, policyNumber };
    const resumed = await resumeAfterPayment({
      session,
      outcome,
      ctx: { payment: { enabled, options }, config },
    });

    // Outside Meta's 24-hour window only an approved template can be delivered.
    // A successful payment is exactly the case that template exists for.
    const templateName =
      status === "completed" ? config.templatePaymentReceived || null : config.templateQuoteReminder || null;

    const delivery = await deliverToSession({
      session,
      replies: resumed.replies,
      config,
      templateName,
      templateParams: status === "completed" ? [policyNumber || session.quoteReference || ""] : [session.quoteReference || ""],
    });

    if (resumed.patch && Object.keys(resumed.patch).length) {
      await updateSession(session.id, { ...resumed.patch, timeoutHours: config.sessionTimeoutHours });
    }

    return {
      notified: delivery.delivered > 0,
      delivery,
      windowOpen: delivery.windowOpen,
      // Handed back so the caller can send the certificate without re-reading
      // the session and the config it has just loaded.
      session,
      config,
      saleId: tx.sale_id || null,
    };
  } catch (err) {
    captureException(err, { scope: "payment_notify_conversation", transactionId });
    return { notified: false, reason: "threw", message: err.message };
  }
}
