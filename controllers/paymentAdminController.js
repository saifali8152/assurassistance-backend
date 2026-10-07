// src/controllers/paymentAdminController.js
//
// The payments screen.
//
// Until this existed, the only way to answer "did that customer's payment go
// through?" was a SQL query — which meant the answer was always "ask the
// developer". An insurance platform taking mobile money has to let its own
// operators see a payment, see why one failed, and retry a stuck one.
//
// PERSONAL DATA STAYS OUT. The payer's number is masked to its last four
// digits everywhere: enough to confirm a number with a customer on the phone,
// useless as a contact list. Raw callback bodies are available but only one at
// a time, deliberately, and every read is written to the activity log.
//
import {
  listTransactions,
  transactionStats,
  getTransactionDetail,
  getCallbackBody,
  getTransactionById,
  setProviderTxId,
} from "../models/paymentModel.js";
import { getProvider } from "../utils/payments/index.js";
import { getProviderConfig } from "../utils/payments/config.js";
import { normaliseResult } from "../utils/payments/provider.js";
import { settlePayment } from "../utils/payments/service.js";
import { PAYMENT_STATES } from "../utils/payments/stateMachine.js";
import { logActivity } from "../models/activityModel.js";

const ok = (res, data, extra = {}) => res.json({ success: true, data, ...extra });
const fail = (res, status, code, message) =>
  res.status(status).json({ success: false, error: { code, message } });

export const listPayments = async (req, res) => {
  try {
    const { page, limit, status, provider, search, from, to } = req.query;
    if (status && !PAYMENT_STATES.includes(status)) {
      return fail(res, 400, "validation_error", `status must be one of: ${PAYMENT_STATES.join(", ")}`);
    }
    const result = await listTransactions({
      page: Number(page) || 1,
      limit: Number(limit) || 25,
      status: status || null,
      provider: provider || null,
      search: search || "",
      from: from || null,
      to: to || null,
    });
    return ok(res, result);
  } catch (err) {
    console.error("listPayments failed:", err);
    return fail(res, 500, "list_failed", "Could not load the payments");
  }
};

export const paymentStats = async (req, res) => {
  try {
    return ok(res, await transactionStats({ days: Number(req.query.days) || 7 }));
  } catch (err) {
    console.error("paymentStats failed:", err);
    return fail(res, 500, "stats_failed", "Could not load the payment figures");
  }
};

export const getPayment = async (req, res) => {
  try {
    const detail = await getTransactionDetail(Number(req.params.id));
    if (!detail) return fail(res, 404, "not_found", "Payment not found");
    return ok(res, detail);
  } catch (err) {
    console.error("getPayment failed:", err);
    return fail(res, 500, "read_failed", "Could not load the payment");
  }
};

/**
 * The raw bytes a provider sent.
 *
 * Audited on purpose: a callback body can contain the provider's own view of a
 * customer, so every look at one is recorded against the person who looked.
 */
export const getPaymentCallbackBody = async (req, res) => {
  try {
    const row = await getCallbackBody(Number(req.params.callbackId));
    if (!row) return fail(res, 404, "not_found", "Callback not found");
    await logActivity(req.user.id, `Viewed raw payment callback ${row.id} (${row.provider})`).catch(() => {});
    return ok(res, row);
  } catch (err) {
    console.error("getPaymentCallbackBody failed:", err);
    return fail(res, 500, "read_failed", "Could not load the callback");
  }
};

/**
 * Ask the provider what happened, now.
 *
 * The poller does this every two minutes, but an operator with a customer on
 * the phone should not have to wait for a cron. If the provider gives a final
 * answer the transaction settles through exactly the same path a callback
 * takes — policy issued, customer told, certificate sent — so a manual check
 * can never produce a different outcome than the automatic one.
 */
export const pollPayment = async (req, res) => {
  try {
    const tx = await getTransactionById(Number(req.params.id));
    if (!tx) return fail(res, 404, "not_found", "Payment not found");
    if (["completed", "failed", "expired", "cancelled"].includes(tx.status)) {
      return ok(res, { settled: false, status: tx.status, reason: "already_final" });
    }

    const provider = getProvider(tx.provider);
    const config = await getProviderConfig(tx.provider);
    if (!provider || !config?.ready) {
      return fail(res, 503, "provider_unavailable", `${tx.provider} is not configured`);
    }

    const result = normaliseResult(
      await provider.checkStatus({
        providerTxId: tx.provider_tx_id,
        reference: tx.reference,
        msisdn: tx.msisdn,
        config,
      }),
      tx.provider
    );

    if (result.providerTxId && !tx.provider_tx_id) {
      await setProviderTxId(tx.id, result.providerTxId).catch(() => {});
    }

    const terminal = ["completed", "failed", "expired", "cancelled"].includes(result.status);
    if (!terminal) {
      return ok(res, { settled: false, status: result.status, reason: "still_waiting" });
    }

    await logActivity(req.user.id, `Polled payment ${tx.reference} → ${result.status}`).catch(() => {});
    const outcome = await settlePayment({
      transactionId: tx.id,
      status: result.status,
      failureCode: result.failureCode || null,
    });

    return ok(res, {
      settled: true,
      status: result.status,
      failureCode: result.failureCode || null,
      policyNumber: outcome.policyNumber || null,
    });
  } catch (err) {
    console.error("pollPayment failed:", err);
    return fail(res, 500, "poll_failed", "Could not ask the provider");
  }
};
