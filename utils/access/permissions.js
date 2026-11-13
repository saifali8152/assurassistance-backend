// utils/access/permissions.js
//
// Milestone 5 (D12) — the permissions that gate the NEW features.
//
// Existing screens keep their existing role checks (adminOnly,
// adminOrAgencyManager…). These permissions exist only for what Phase 2 adds,
// so introducing them cannot change what anyone could already do.
//
// The main admin (users.role = 'admin') always has every one of them, whatever
// the tables say: an admin can never lock themselves out of claims.
//
export const PERMISSIONS = [
  { code: "claims.view", group: "claims", fr: "Voir les sinistres", en: "View claims" },
  { code: "claims.update_status", group: "claims", fr: "Changer le statut d'un sinistre", en: "Change a claim's status" },
  { code: "claims.documents", group: "claims", fr: "Ouvrir les justificatifs", en: "Open claim documents" },
  { code: "claims.settings", group: "claims", fr: "Paramètres des sinistres", en: "Claims settings" },
  { code: "claims.categories", group: "claims", fr: "Catégories de sinistres", en: "Claim categories" },
  { code: "claims.activate", group: "claims", fr: "Activer / désactiver les sinistres", en: "Switch claims on / off" },
  { code: "claims.allowlist", group: "claims", fr: "Numéros de test", en: "Test numbers (allowlist)" },
  { code: "policies.import", group: "policies", fr: "Importer des polices", en: "Import policies" },
  { code: "simulator.use", group: "tools", fr: "Simulateur WhatsApp", en: "WhatsApp simulator" },
];

export const PERMISSION_CODES = PERMISSIONS.map((p) => p.code);

/** Only the main admin manages roles; it is not a grantable permission, so no
 *  custom role can hand itself more access. */
export const ADMIN_ONLY = ["access.manage"];

export function isKnownPermission(code) {
  return PERMISSION_CODES.includes(code);
}
