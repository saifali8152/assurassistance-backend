# Assur'Assistance — Phase 2 (M4 + M5) — working state

_Last updated: 13 Nov 2026 (late). Source of truth for picking this work up in a new session._

## Status: built, tested, documented — ready to deploy (Saif runs the deploy)

Nothing committed or pushed (the folder is not a git repository). Claims ship **OFF**.

## Verified on 13 Nov (late)
- Backend unit **422/422**, integration **174/174** on a throwaway DB (dump + legacy migrations +
  `npm run migrate`; migrate re-run = up to date; suite run twice).
- Frontend `tsc -b` + `vite build` clean; eslint clean on all Phase 2 screens; type-check also run on the Mac.
- Scripted browser click-through (admin, Claims handler, supervisor, agent; EN + FR; 1440 + 820 px) —
  31 checks pass. Details: `docs/TEST_REPORT_PHASE2.md`.
- Soft-deleted policy still downloads its certificate (checked by hand).

## Done in the review pass (13 Nov late)
- Reviewed Claude Code's work (staff users endpoint, frontend screens): correct; fixed what follows.
- Frontend: permissions wait for session restore (direct links no longer bounce to /unauthorized);
  new screens/dialogs left-aligned (global `#root{text-align:center}`); bordered custom dropdowns
  (`select.p2-input`, global `select{border:none}`); **premium filter bar** (`FilterBar`, `FilterField`,
  `SearchField`, `DateRangeField`, `Toggle`, `FilterChip` in `components/admin/ui.tsx`) on Claims and Imported
  policies; simulator state panel redesigned (journey translated, "Finished" state, FR/EN segmented toggle);
  Escape closes dialogs; Roles tabs as a segmented control; card/tile shadows; WhatsApp conversations
  left-aligned with inbound bubbles; `claims:read` in its own "Claims" group in the API-key scope picker.
- **Privacy fix:** claim conversations are filtered out of `/api/whatsapp/sessions*` for API keys (any scope)
  and staff without `claims.view`; claim-step messages removed from purchase transcripts
  (`whatsappController.canReadClaimConversations`, `listSessions/listSessionMessages({ excludeClaims })`).
  Test: `tests/integration/claimTranscriptPrivacy.integration.test.mjs`.
- **Access fix (older hole):** with a user login, `/api/whatsapp/sessions*`, `/stats` and `POST /messages` are
  now main-admin only (`adminUnlessApiKey` in `routes/whatsappRoutes.js`); before, any signed-in user — agents
  included — could read every transcript and send a WhatsApp message to any number. API keys unchanged
  (scopes). Claim page shows "Open the WhatsApp conversation" to admins only.
- Partner API: `GET /api/claims` refuses an invalid `updatedSince` / unsupported `status` with
  `400 invalid_parameter` (was silently empty). Tests added to `partnerClaims.integration.test.mjs`.
- Docs: `API.md` §19 (claims) + §20 (Phase 2 admin endpoints) + WhatsApp note + error code;
  `INTEGRATION_GUIDE.md` §5c + scope row + error row; `SECURITY.md` claims paragraph; `openapi.yaml`
  Claims tag, `ClaimStatus` schema, two paths (no new lint problems; 179 pre-existing); Postman "Claims"
  folder; `SCHEMA.md` Phase 2 section + sensitive-data rows; `RUNBOOK.md` crons + §7 Claims.
- Partner package `client-integration-package/` updated (docs + README + QUICK_START, CRLF kept) and
  **`CREDENTIALS.txt` replaced by a blank template**; `assurassistance-api-integration.zip` rebuilt (flat, 8 files).
- New: `docs/DEPLOY_PHASE2.md` (VPS steps), `docs/TEST_REPORT_PHASE2.md`,
  `docs/CLAIMS_ADMIN_GUIDE_EN.md` / `_FR.md` (handover guides for staff).

## Done earlier (summary)
- **M4:** switch + allowlist; claim conversation (SINISTRE/CLAIM, SUIVI <ref>, resume, urgent words, review/edit,
  consent, purchase parked during a claim); policy validation with lockouts; documents (magic bytes,
  AES-256-GCM, re-fetch job, retention); submission (reference, snapshot, outbox email); abandon-draft job.
- **M5:** roles/permissions + Claims handler template; login lockout (5 / 15 min); admin audit; claims admin
  API + screens; imported policies (CSV/Excel preview/commit, add one, exact-passport search); certificate
  re-send; simulator (never sends, pays or writes cases); idle timeout (30 min); list masking on screen only.

## Decisions (unchanged)
- List masking on screen only; backend list unchanged. Allowlisted numbers' claims are test claims.
- Excel parsed in the browser (`xlsx`), CSV sent raw. Idle timeout 30 min (`VITE_IDLE_TIMEOUT_MINUTES`).

## Remaining — Saif
1. Deploy per `docs/DEPLOY_PHASE2.md` (backup → upload → 11 migrations → `storage/claims` → `.env` → 4 crons →
   frontend build/FTP → confirm claims OFF).
2. **Revoke the API key that was in the old `CREDENTIALS.txt`** (owner user 1) and send partners the new zip.
3. The client's admin sets, in the panel: notification emails, categories/documents, retention period, who gets
   the Claims handler role (checklist at the top of `CLAIMS_ADMIN_GUIDE_EN/FR.md`).
4. After WhatsApp is connected: test from an allowlisted phone end-to-end (document download from Meta,
   SUIVI, certificate re-send), then switch claims on.

## Known limits / optional follow-ups
- `openapi.yaml` has 179 lint errors predating Phase 2.
