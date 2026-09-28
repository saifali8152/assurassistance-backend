// src/controllers/settingsController.js
//
// Superadmin management of the WhatsApp integration settings.
//
//   GET    /api/admin/whatsapp-settings                     read (secrets masked)
//   PUT    /api/admin/whatsapp-settings                     save
//   POST   /api/admin/whatsapp-settings/test                live Graph API check
//   POST   /api/admin/whatsapp-settings/verify-token        generate a new token
//   GET    /api/admin/whatsapp-settings/verify-token        reveal it once, logged
//   GET    /api/admin/whatsapp-settings/attribution-candidates
//
// SECRET HANDLING
//   Secrets are returned masked ("••••••••wxyz") and are write-only: sending an
//   empty string or omitting the field leaves the stored value untouched, so the
//   admin can edit the phone number id without retyping the access token. Only
//   an explicit null clears a secret.
//
//   The webhook verify token is the one exception to "never reveal": the operator
//   has to paste it into the Meta dashboard. Revealing it is a separate, audited
//   request rather than something that rides along with every page load.
//
import {
  SETTING_REGISTRY,
  SETTING_KEYS,
  isKnownSettingKey,
  validateSettingValue,
  saveSettings,
  getSettingRows,
} from "../models/settingsModel.js";
import {
  loadSettings,
  invalidateSettings,
  getWhatsAppConfig,
  getWebhookUrl,
  getDecryptionErrors,
} from "../utils/appSettings.js";
import {
  encryptionAvailable,
  maskSecret,
  generateVerifyToken,
} from "../utils/appCrypto.js";
import { logActivity } from "../models/activityModel.js";
import getPool from "../utils/db.js";

const WHATSAPP_KEYS = SETTING_KEYS.filter((k) => k.startsWith("whatsapp."));

const ok = (res, data, extra = {}) => res.json({ success: true, data, ...extra });
const fail = (res, status, code, message, extra = {}) =>
  res.status(status).json({ success: false, error: { code, message, ...extra } });

/**
 * Build the client-facing view of one setting: the value if it is safe to show,
 * a mask if it is not, plus enough metadata for the UI to render the field
 * without hardcoding a second copy of the registry.
 */
function presentSetting(key, resolvedValue) {
  const def = SETTING_REGISTRY[key];
  const base = {
    key,
    group: def.group,
    type: def.type,
    secret: Boolean(def.secret),
    description: def.description || null,
    allowed: def.allowed || null,
    min: def.min ?? null,
    max: def.max ?? null,
  };

  if (def.secret) {
    return { ...base, value: null, masked: maskSecret(resolvedValue), isSet: Boolean(resolvedValue) };
  }
  return { ...base, value: resolvedValue ?? null, masked: null, isSet: resolvedValue !== null && resolvedValue !== "" };
}

export const getWhatsAppSettings = async (req, res) => {
  try {
    const resolved = await loadSettings({ force: true });
    const rows = await getSettingRows(WHATSAPP_KEYS);
    const meta = new Map(rows.map((r) => [r.setting_key, r]));
    const cfg = await getWhatsAppConfig();

    const settings = WHATSAPP_KEYS.map((key) => {
      const row = meta.get(key);
      return {
        ...presentSetting(key, resolved[key]),
        updated_at: row?.updated_at || null,
        updated_by_user_id: row?.updated_by_user_id || null,
      };
    });

    return ok(res, {
      settings,
      status: {
        enabled: cfg.enabled,
        ready: cfg.ready,
        missing: cfg.missing,
        encryptionAvailable: encryptionAvailable(),
        decryptionErrors: getDecryptionErrors().map((e) => e.key),
      },
      webhook: {
        url: getWebhookUrl(),
        // Meta only ever sends GET for verification and POST for events.
        methods: ["GET", "POST"],
        verifyTokenSet: Boolean(cfg.verifyToken),
      },
    });
  } catch (err) {
    console.error("getWhatsAppSettings failed:", err);
    return fail(res, 500, "settings_read_failed", "Could not load the WhatsApp settings");
  }
};

export const updateWhatsAppSettings = async (req, res) => {
  try {
    const incoming = req.body?.settings ?? req.body;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return fail(res, 400, "validation_error", "Expected an object of setting keys and values");
    }

    const entries = [];
    const errors = [];
    const skipped = [];

    for (const [key, rawValue] of Object.entries(incoming)) {
      if (!isKnownSettingKey(key) || !key.startsWith("whatsapp.")) {
        errors.push({ key, message: "Unknown setting key" });
        continue;
      }
      const def = SETTING_REGISTRY[key];

      // Secrets: "" or undefined means "keep what is stored".
      if (def.secret && (rawValue === undefined || rawValue === "")) {
        skipped.push(key);
        continue;
      }

      const result = validateSettingValue(key, rawValue);
      if (!result.ok) {
        errors.push({ key, message: result.message });
        continue;
      }
      entries.push({ key, value: result.value });
    }

    if (errors.length) {
      return fail(res, 400, "validation_error", "Some settings could not be saved", { fields: errors });
    }

    // Writing a secret without a master key would store plaintext. Refuse instead.
    const writingSecret = entries.some(({ key, value }) => SETTING_REGISTRY[key].secret && value !== null);
    if (writingSecret && !encryptionAvailable()) {
      return fail(
        res,
        503,
        "encryption_unavailable",
        "SETTINGS_ENCRYPTION_KEY is not configured on the server, so credentials cannot be stored securely. Generate one with: openssl rand -hex 32"
      );
    }

    if (!entries.length) {
      return ok(res, { changed: [], skipped }, { message: "Nothing to update" });
    }

    const changed = await saveSettings(entries, req.user?.id);
    invalidateSettings();

    // Audit trail: which keys changed, never their values.
    await logActivity(req.user.id, `Updated WhatsApp settings: ${changed.join(", ")}`).catch(() => {});

    const cfg = await getWhatsAppConfig();
    return ok(
      res,
      { changed, skipped, status: { enabled: cfg.enabled, ready: cfg.ready, missing: cfg.missing } },
      { message: "Settings saved" }
    );
  } catch (err) {
    console.error("updateWhatsAppSettings failed:", err);
    return fail(res, 500, "settings_write_failed", "Could not save the WhatsApp settings");
  }
};

/**
 * Live check against the Graph API. Confirms three things the operator cannot
 * verify by looking at the form: the token is valid, it has access to THIS phone
 * number id, and the number is in a usable state.
 */
export const testWhatsAppConnection = async (req, res) => {
  try {
    const cfg = await getWhatsAppConfig();

    if (!cfg.accessToken || !cfg.phoneNumberId) {
      return fail(res, 400, "incomplete_configuration",
        "Save the phone number ID and access token before testing the connection.");
    }

    const url = `https://graph.facebook.com/${cfg.apiVersion}/${encodeURIComponent(cfg.phoneNumberId)}` +
      `?fields=display_phone_number,verified_name,quality_rating,platform_type`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    let response;
    let body;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${cfg.accessToken}` },
        signal: controller.signal,
      });
      body = await response.json().catch(() => ({}));
    } catch (err) {
      clearTimeout(timer);
      const aborted = err.name === "AbortError";
      return fail(res, 504, aborted ? "graph_timeout" : "graph_unreachable",
        aborted
          ? "Meta did not respond within 10 seconds."
          : `Could not reach the Meta Graph API: ${err.message}`);
    }
    clearTimeout(timer);

    await logActivity(req.user.id, "Tested the WhatsApp connection").catch(() => {});

    if (!response.ok) {
      const metaError = body?.error || {};
      return fail(res, 400, "graph_error",
        metaError.message || `Meta returned HTTP ${response.status}`,
        {
          metaCode: metaError.code ?? null,
          metaSubcode: metaError.error_subcode ?? null,
          metaType: metaError.type ?? null,
        });
    }

    return ok(res, {
      phoneNumberId: cfg.phoneNumberId,
      displayPhoneNumber: body.display_phone_number || null,
      verifiedName: body.verified_name || null,
      qualityRating: body.quality_rating || null,
      platformType: body.platform_type || null,
      apiVersion: cfg.apiVersion,
    }, { message: "Connection to Meta confirmed" });
  } catch (err) {
    console.error("testWhatsAppConnection failed:", err);
    return fail(res, 500, "connection_test_failed", "The connection test could not be completed");
  }
};

/** Generate and store a new verify token. Returned once, in clear, on purpose. */
export const regenerateVerifyToken = async (req, res) => {
  try {
    if (!encryptionAvailable()) {
      return fail(res, 503, "encryption_unavailable",
        "SETTINGS_ENCRYPTION_KEY is not configured on the server.");
    }
    const token = generateVerifyToken();
    await saveSettings([{ key: "whatsapp.verify_token", value: token }], req.user?.id);
    invalidateSettings();
    await logActivity(req.user.id, "Regenerated the WhatsApp webhook verify token").catch(() => {});

    return ok(res, { verifyToken: token, webhookUrl: getWebhookUrl() }, {
      message: "New verify token generated. Paste it into the Meta dashboard — it will not be shown again unless you reveal it.",
    });
  } catch (err) {
    console.error("regenerateVerifyToken failed:", err);
    return fail(res, 500, "verify_token_failed", "Could not generate a verify token");
  }
};

/**
 * Reveal the verify token. Separate and audited, because the operator genuinely
 * needs to read this one value back to configure Meta.
 */
export const revealVerifyToken = async (req, res) => {
  try {
    const cfg = await getWhatsAppConfig();
    if (!cfg.verifyToken) {
      return fail(res, 404, "not_set", "No verify token has been saved yet");
    }
    await logActivity(req.user.id, "Revealed the WhatsApp webhook verify token").catch(() => {});
    return ok(res, { verifyToken: cfg.verifyToken, webhookUrl: getWebhookUrl() });
  } catch (err) {
    console.error("revealVerifyToken failed:", err);
    return fail(res, 500, "reveal_failed", "Could not read the verify token");
  }
};

/**
 * Accounts that can own WhatsApp-originated business. Needed because the sales
 * chain (commissions, partner invoices, ledger, reconciliation) is keyed to a
 * user, and a WhatsApp customer has no agent of their own.
 */
export const listAttributionCandidates = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const pool = getPool();
    const params = [];
    let where = "WHERE u.status = 'active' AND u.role IN ('admin','sub_admin','agent')";
    if (search) {
      where += " AND (u.name LIKE ? OR u.email LIKE ?)";
      params.push(`%${search}%`, `%${search}%`);
    }
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, u.role
       FROM users u
       ${where}
       ORDER BY FIELD(u.role,'admin','sub_admin','agent'), u.name ASC
       LIMIT 200`,
      params
    );
    return ok(res, rows);
  } catch (err) {
    console.error("listAttributionCandidates failed:", err);
    return fail(res, 500, "candidates_failed", "Could not load the account list");
  }
};
