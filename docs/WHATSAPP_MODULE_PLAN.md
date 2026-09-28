# WhatsApp Purchase Module — Implementation Plan (Milestone 2)

**Status:** built and verified — awaiting the client-side prerequisites in §7
**Stack:** Express 5 (ESM) + MySQL 8 + React/Vite — the stack already in production.
**Applies to:** `backend/` and `frontend/` of this repository.

---

## 0. Non-negotiable rules for this milestone

1. **The live database is never destroyed.** No `DROP TABLE`, no `DROP COLUMN`, no
   `MODIFY` that narrows a type, no `TRUNCATE`, no destructive `UPDATE`. Every schema
   change is **additive** (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN`, `ADD KEY`) and
   guarded through `information_schema` so a re-run is a no-op instead of an error.
   This matches the existing style in `migrations/` (see `add_api_keys.sql`,
   `add_certificates_public_token.sql`).
2. **Nothing is committed or pushed to git.** Files are written to the working tree only.
3. **No existing behaviour changes.** The web flow, agent hierarchy, commissions,
   certificates and invoices keep working exactly as they do now. The WhatsApp module is
   additive: new tables, new routes under `/api/whatsapp`, new admin settings.
4. **Every new capability is exposed through the third-party API** with its own scope,
   documented in `docs/API.md`, `docs/openapi.yaml`, `docs/postman_collection.json`, and
   mirrored byte-for-byte into `client-integration-package/`.
5. **No secrets in `.env` once the module is live.** WhatsApp credentials are stored
   encrypted in `app_settings` and managed by the superadmin in the UI. `.env` keeps only
   the master encryption key and a first-boot fallback.
6. **Frontend follows the existing theme.** Primary `#E4590F`, Poppins, `rounded-xl`
   surfaces, lucide icons, `react-i18next` with inline English defaults, `react-hot-toast`,
   `src/api/*.ts` modules on top of `src/lib/api.ts`.

---

## 1. Phases

| Phase | Deliverable | Depends on |
|---|---|---|
| 1 | Migrations + migration runner | — |
| 2 | Encrypted settings backend | 1 |
| 3 | Superadmin settings UI | 2 |
| 4 | Webhook + Meta transport | 2 |
| 5 | Conversation engine + sessions | 4 |
| 6 | Validation + shared reference data | 1 |
| 7 | Pricing zones + tests | 1 |
| 8 | Backend i18n + data-collection flow + quote | 5, 6, 7 |
| 9 | Third-party API exposure | 8 |
| 10 | Docs + client integration package | 9 |
| 11 | Hardening, testing, demo prep | all |

---

## 2. Phase 1 — Database

New migration files, applied in this order:

| File | Adds |
|---|---|
| `add_schema_migrations.sql` | `schema_migrations` ledger for the runner |
| `add_app_settings.sql` | `app_settings` — generic encrypted key/value config |
| `add_destination_zones.sql` | `destination_zones` — country → pricing zone |
| `add_whatsapp_tables.sql` | `whatsapp_sessions`, `whatsapp_messages`, `whatsapp_flows` |
| `add_whatsapp_fields_to_travellers.sql` | `whatsapp_number`, `source`, `preferred_language` |
| `add_whatsapp_fields_to_catalogue.sql` | `coverage_summary_fr`, `coverage_summary_en`, `whatsapp_enabled` |
| `add_quote_fields_to_cases.sql` | `quote_reference`, `source`, `AwaitingPayment` status |
| `seed_destination_zones.sql` | Country → zone rows, FR + EN names |

Runner: `scripts/migrate.js` — reads `migrations/*.sql` in filename order, skips anything
already in `schema_migrations`, applies the rest inside a transaction where MySQL allows it,
and records the filename plus a SHA-256 of its contents. Idempotent by construction.

`status` on `cases` is widened by **adding** `'AwaitingPayment'` to the existing ENUM —
existing values `Draft`/`Confirmed`/`Cancelled` are preserved in the same order, so no row
is rewritten.

---

## 3. Phase 2 — Settings backend

- `utils/appCrypto.js` — AES-256-GCM encrypt/decrypt, master key from `SETTINGS_ENCRYPTION_KEY`.
- `models/settingsModel.js` — typed get/set, secret vs plain values, bulk read.
- `utils/settingsCache.js` — in-process cache, invalidated on write, so a saved change takes
  effect on the next webhook call with no restart.
- `controllers/settingsController.js` + `routes/settingsRoutes.js` — `authenticate` + `adminOnly`.
- Secrets are returned masked (`••••last4`) and are write-only.
- `POST /api/admin/whatsapp-settings/test` performs a live Graph API call.
- Every change is written to the existing activity log.

Settings keys: `whatsapp.phone_number_id`, `whatsapp.waba_id`, `whatsapp.access_token` (secret),
`whatsapp.app_secret` (secret), `whatsapp.verify_token` (secret), `whatsapp.api_version`,
`whatsapp.default_language`, `whatsapp.session_timeout_hours`, `whatsapp.escalation_number`,
`whatsapp.enabled`, `whatsapp.attribution_user_id`.

---

## 4. Phase 3 — Settings UI

`src/pages/WhatsAppSettings.tsx`, route `/admin/whatsapp-settings`, admin-only, listed under
the existing **System** sidebar section. Sections: connection credentials, conversation
defaults, sales attribution, webhook details (read-only, copy to clipboard), connection test.
FR + EN keys added to both `src/locales/*/translation.json`.

---

## 5. Phases 4–8 — WhatsApp module

```
backend/
  routes/whatsappRoutes.js          webhook + admin/3rd-party endpoints
  controllers/whatsappController.js
  models/whatsappModel.js           sessions + message log
  utils/whatsapp/client.js          Graph API send, retry/backoff
  utils/whatsapp/signature.js       X-Hub-Signature-256
  utils/whatsapp/parser.js          inbound Meta payload → normalised message
  utils/whatsapp/engine.js          step machine
  utils/whatsapp/flow.default.js    the 10-step purchase flow, as data
  utils/whatsapp/commands.js        RESTART / BACK / HELP / AGENT / language
  utils/validators.js               server-side field validation (new)
  utils/referenceData.js            countries + nationalities, FR/EN (ported from frontend)
  utils/destinationZones.js         zone resolver
  i18n/fr.json, i18n/en.json        server-side strings, French default
```

The webhook route is mounted with `express.raw({ type: 'application/json' })` **before**
`express.json()` and before the sanitisation middleware in `server.js`, otherwise the
signature can never be verified.

---

## 6. Phase 9 — Third-party API exposure

New scopes appended to `ALLOWED_SCOPES` in `models/apiKeyModel.js`:

| Scope | Grants |
|---|---|
| `quotes:read` | Read quotes and their computed premium |
| `quotes:write` | Create a quote (price a traveller without issuing a policy) |
| `zones:read` | Read destination zone mapping |
| `whatsapp:read` | Read sessions and message logs |
| `whatsapp:write` | Send an outbound message / trigger a flow |

New endpoints, all through `authenticateAny` + `requireScope` so both our own JWT frontend
and partner API keys can call them:

- `POST /api/quotes` — price a traveller (age band, duration tier, destination zone) without
  creating a case. This is the pricing engine finally exposed as a product.
- `GET /api/quotes/:reference`
- `GET /api/zones` and `GET /api/zones/resolve?country=CI`
- `GET /api/whatsapp/sessions`, `GET /api/whatsapp/sessions/:id/messages`
- `POST /api/whatsapp/messages` — outbound send
- `GET /api/whatsapp/settings/public` — non-secret runtime config

Partners therefore gain a quoting API in the same milestone, at no extra build cost, because
the WhatsApp flow needs exactly that engine.

---

## 7. Open decisions needed from the client

1. **Sale attribution.** `createSaleController` requires `req.user.id`, and commissions,
   partner invoices, the ledger and reconciliation all key off the owning agent. A WhatsApp
   customer has no agent. Default in this build: a dedicated `WhatsApp Direct` account,
   selectable in settings (`whatsapp.attribution_user_id`). The client must confirm whether
   commission accrues to head office or to a partner.
2. **Destination zone table.** Today `pricing_rules.pricingColumns` is effectively
   `["Worldwide"]`. Zone-based pricing is built but stays single-zone until the client
   supplies the mapping.
3. **Message retention.** How long `whatsapp_messages` keeps transcripts (they contain PII).
   Default in this build: 180 days, configurable.
4. **Premium table** per age band × duration × zone, and the coverage summary per duration
   in FR and EN for the WhatsApp quote message.

---

## 8. Out of scope (Milestone 3 / Phase 2)

Payment gateways (Orange Money, MTN MoMo, Wave, Moov), payment confirmation, live-number
production cutover, claims module, human-agent escalation handling beyond logging the request.
PDF certificates, policy numbering and invoices already exist and are reused as-is.

---

## 9. What was built

### Backend

| Area | Files |
|---|---|
| Migrations | `migrations/m2_01…m2_08_*.sql` (additive, guarded, re-runnable) |
| Migration runner | `scripts/migrate.js` + `npm run migrate[:status|:dry|:baseline]` |
| Encrypted settings | `utils/appCrypto.js`, `models/settingsModel.js`, `utils/appSettings.js`, `controllers/settingsController.js`, `routes/settingsRoutes.js` |
| Validation | `utils/validators.js` — the backend had none before |
| Reference data | `models/referenceModel.js`, `utils/referenceData.js` |
| Pricing | `utils/quoteEngine.js` (zones layered over the existing engine, which is untouched) |
| Server i18n | `utils/i18n.js`, `i18n/fr.json`, `i18n/en.json` — 146 keys, FR and EN in step |
| WhatsApp transport | `utils/whatsapp/signature.js`, `parser.js`, `client.js` |
| Conversation | `utils/whatsapp/flow.default.js`, `commands.js`, `engine.js`, `models/whatsappModel.js` |
| Webhook + APIs | `controllers/whatsappController.js`, `routes/whatsappWebhookRoutes.js`, `routes/whatsappRoutes.js` |
| Quoting API | `controllers/quoteController.js`, `models/quoteModel.js`, `routes/quoteRoutes.js` |
| Zones API | `controllers/zoneController.js`, `routes/zoneRoutes.js` |
| Tests | `tests/{pricing,validators,conversation,webhook}.test.mjs` — 147 tests, `npm test` |

Existing files touched, minimally: `server.js` (four mounts), `models/apiKeyModel.js`
(five new scopes appended), `package.json` (scripts), `.env.example` (documentation).
No existing behaviour was changed.

### Frontend

`src/pages/WhatsAppSettings.tsx`, `src/api/whatsappSettingsApi.ts`, a route in
`App.tsx`, a nav entry in `Layout.tsx`, and 83 new keys in each translation file.

### New API scopes

`quotes:read`, `quotes:write`, `zones:read`, `whatsapp:read`, `whatsapp:write` —
documented in `API.md` §14–17, `openapi.yaml`, `postman_collection.json`, and
mirrored into `client-integration-package/` plus the distributable zip.

---

## 10. Verification performed

Against a scratch MySQL built from `database_dump.sql` plus the legacy
migrations, seeded with representative users, plans, travellers, cases and sales.

**Migrations**

- The `cases` data hash was byte-identical before and after all eight migrations.
- Every migration was re-applied by hand through the CLI: no-op, no errors.
- An operator-changed setting and a manually reassigned zone both survived a
  re-run — `INSERT IGNORE` never overwrites operator edits.
- `'AwaitingPayment'` appended to the status ENUM left `Draft` / `Confirmed` /
  `Cancelled` rows untouched.

**Running server, real HTTP**

- Settings: read, write, per-field validation, masked secrets, partial saves that
  do not clear a token, ciphertext confirmed in the column, zero plaintext leaks.
- Access control: agent JWT → 403, no auth → 401, API key on the settings
  endpoints → 401 regardless of scopes.
- Webhook: correct verify token → `200` + echoed challenge; wrong token, wrong
  mode, no params → `403`. Missing and forged signatures → `403`; valid → `200`.
- Meta redelivery of the same `wa_message_id` was ignored, with one archived row.
- A full purchase conversation driven through the signed webhook: French copy,
  seven customer answers, correct data captured, quote persisted as a case with
  `source='whatsapp'` and the configured attribution account.
- Pricing over HTTP: every age band (×0.5, ×1, ×2, ×4, ineligible), per-plan
  duration tiers (10/32/63), and zone-differentiated premiums (France in Zone A
  priced from the Zone A column, Côte d'Ivoire from Worldwide, on the same plan).
- Scope enforcement: a key without `quotes:write` → `insufficient_scope`; without
  `whatsapp:read` → 403.

**Two real bugs were found and fixed this way**

1. `toISOString()` on a DATE column shifted every travel date and date of birth
   one day earlier on any server east of Greenwich — which includes the
   production VPS. Now serialised from local date parts, with a regression test.
2. The review screen printed "Votre devis Non renseigné" because it showed a
   quote reference that does not exist until confirmation, and omitted the
   coverage highlights entirely. Both fixed, with tests.

---

## 11. Go-live runbook

```bash
# 1. One-time, per environment
openssl rand -hex 32          # -> SETTINGS_ENCRYPTION_KEY in .env

# 2. Tell the runner the legacy migrations are already live (once, per database)
npm run migrate:baseline

# 3. Review, then apply
npm run migrate:status
npm run migrate:dry
npm run migrate

# 4. Confirm
npm test
```

Then, in the admin UI at **/admin/whatsapp-settings**:

1. Enter the phone number ID, business account ID, access token and app secret.
2. Press **Test connection** — this must pass before going further.
3. **Generate** a verify token, copy the callback URL and the token into
   Meta → WhatsApp → Configuration, and subscribe to the `messages` field.
4. Choose the **owning account** for WhatsApp sales (see §7.1).
5. Enable the plans that may be sold over chat (`catalogue.whatsapp_enabled`) and
   give each a short FR/EN coverage summary for the quote message.
6. Turn the **WhatsApp purchase flow** switch on.

Nothing is sent or answered while the switch is off, even with valid credentials
saved — so steps 1–5 are safe to do on production at any time.
