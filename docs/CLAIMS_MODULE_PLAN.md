# Claims Module — Implementation Plan (Milestone 4)

**Status:** planned — nothing built yet
**Source:** `development-plan-milestone-4.md` (client plan, 8 working days)
**Stack:** the same Express 5 + MySQL 8 + React/Vite stack, and the M2/M3 conversation engine

Every line of the client plan appears below, tagged with where it starts from:

- **[exists]** — already built and working; M4 only uses it
- **[reuse]** — the machinery exists for purchases; M4 points it at claims
- **[adjust]** — exists, but has to change to support claims without breaking purchases
- **[new]** — nothing to build on; written from scratch

---

## 0. Rules carried over from M2/M3

1. **The live database is never damaged.** Every migration is additive, guarded and
   re-runnable (`m4_*`). No `DROP`, no narrowing `MODIFY`, no destructive `UPDATE`.
2. **Nothing is committed or pushed.** Files land in the working tree only.
3. **The purchase flow does not change behaviour.** Claims are a second journey beside
   it, behind a flag that is **off** until the client switches it on.
4. **Every new capability is exposed through the third-party API** and documented in
   `API.md`, `openapi.yaml` and Postman, mirrored into the partner package and zip.
5. **Everything the client has to supply is entered in the admin panel**, not `.env`.
6. **Frontend follows the existing theme** (`#E4590F`, Poppins, `rounded-xl`, lucide).

---

## 1. Where we start — audit

Nothing claims-related exists today. A search of backend and frontend for *claim /
sinistre / réclamation* finds only two unrelated words ("disclaimer"). What does exist
is most of the machinery the client plan assumes, which is why 8 days is realistic —
with the adjustments below.

| Area | State | Evidence |
|---|---|---|
| Conversation engine (buttons, lists, text, review, back, restart, help, agent, language switch) | **reuse** | `utils/whatsapp/engine.js`, `commands.js` |
| Data-driven flow definitions | **reuse** | `flow.default.js`, `whatsapp_flows` table |
| More than one flow per number | **adjust** | `whatsapp_sessions.flow_key` exists but only `purchase` is ever loaded; `RESTART` jumps to the purchase start |
| Main menu with room for "claims" | **adjust** | Welcome step already uses **3 buttons — Meta's maximum**. A 4th option needs a list picker |
| Session persistence and resume | **reuse** | `session.expiredResume`, `expireStaleSessions()` |
| FR/EN localisation | **reuse** | `i18n/fr.json`, `en.json` (182 keys, parity enforced by test) |
| Atomic number allocation | **reuse** | `utils/documentNumbers.js` → `allocateNumber(conn, seqKey, format)` over `policy_sequences`, proven unique under 12 concurrent connections |
| State machine with history | **reuse** | the payments state machine pattern (`utils/payments/stateMachine.js`) |
| Policy lookup by number | **exists** | `sales.policy_number` is UNIQUE |
| Passport cross-check | **exists** | `travellers.passport_or_id_hash` — the keyed blind index built in M3 is exactly an exact-match lookup on an encrypted value |
| Policy snapshot | **exists** | `certificates.issued_snapshot` — frozen at issuance, re-frozen on audited edits |
| Cancelled policy detection | **exists** | `sales.deleted_at` |
| Assistance card number | **new** | No such field anywhere in the schema (see decision D3) |
| Rate limiting per WhatsApp number | **adjust** | Exists, but in memory, 20 msg/min, resets on restart — built to stop flooding, far too loose to stop guessing a passport |
| Inbound images and documents | **adjust** | `parser.js` classifies `image`/`document` as **unsupported** and drops the media id |
| Media download from Meta | **new** | No Graph media calls in `client.js` |
| Private file storage | **reuse** | `storage/` (not web-served) built for certificates in M3 |
| Encryption at rest | **adjust** | `appCrypto.js` is AES-256-GCM over strings; files need a buffer variant |
| Content-type sniffing | **new** | No library; jpg/png/pdf magic bytes are simple enough to check without one |
| S3 / object storage | **new** | No AWS dependency (see decision D2) |
| Virus scanning | **new** | Nothing installed (see decision D8) |
| Email delivery | **reuse** | `nodemailer` + `utils/alerts.js` |
| Reliable internal notification | **new** | `notifyOps` deliberately throttles and de-duplicates — right for alerts, wrong for "every claim must reach the claims team". Needs a retried outbox |
| Admin settings with encryption | **reuse** | `app_settings` registry + Payment Settings screen pattern |
| Scheduled jobs | **reuse** | `scripts/*.js` + cron, documented in RUNBOOK |
| Partner API, scopes, docs | **reuse** | `ALLOWED_SCOPES` in `apiKeyModel.js` |
| Test harness | **reuse** | `node:test` unit + opt-in integration (`IT_DB_NAME`), conversation harness in `tests/conversation.test.mjs` |
| **Staging environment** | **missing** | None exists. `.env.example` mentions `staging.assurassistancepro.org` only as a CORS example (see decision D1) |

---

## 2. Decisions needed before Day 1

Each has a recommendation; none blocks writing code, but several block *finishing* it.

| # | Decision | Owner | Recommendation |
|---|---|---|---|
| **D1** | **Staging.** The client plan's key constraint is "built and tested in staging only", and there is no staging. | Saif | Stand up `staging.assurassistancepro.org` on the same VPS: second PM2 process, separate database, separate `.env`, and **Meta's free test number** (one WhatsApp number can only point at one webhook). The alternative — deploy dark to production behind the flag — contradicts the plan's own constraint. |
| **D2** | **Document storage.** Plan says "S3 or equivalent". | Saif / client | Encrypted files under `storage/claims/` on the VPS, behind a storage interface so S3 can be swapped in later without touching the flow. S3 needs the client's AWS account and a monthly bill; nothing about M4 requires it. |
| **D3** | **What is the "assistance card number"?** No such number exists in the platform. | Client | Very likely the **certificate number** (`CERT-2026-…`) — the certificate *is* the assistance card the traveller carries. If so, nothing new to store. If it's a separate physical card, we need its format and where it's issued. |
| **D4** | **Can an unpaid policy be claimed against?** `payment_status` can be `Unpaid`. | Client | Accept the claim, flag it `unpaid_policy` for the claims team. Intake is not adjudication. |
| **D5** | **Expiry is judged at the incident date, not today.** The plan says "policy status check — expired". | Client | A traveller who falls ill on day 10 and files a week after getting home is claiming against a policy that was in force. Reject only if the *incident* is outside cover. Optionally a **filing window** (e.g. 90 days after policy end) — client rule. |
| **D6** | **Guarantee coverage.** A plan may not include, say, trip cancellation. | Client | Never refuse intake for this; flag `guarantee_not_on_plan` on the case. Refusing a claim is adjudication, which is out of contract. |
| **D7** | **Mid-purchase isolation.** One active session per number is enforced by a unique index. | Saif | A customer mid-purchase who asks to claim gets a confirm prompt; the purchase draft is **parked**, not lost, and offered back afterwards. A customer **waiting on a payment** cannot enter claims until it settles — a payment callback must never land on a session that has moved to another journey. |
| **D8** | **Virus scanning.** | Saif | Ship a scan hook that is a documented no-op by default, with a ClamAV adapter that activates if `clamd` is installed on the server. Allowlisting jpg/png/pdf by magic bytes already rules out executables and archives. |
| **D9** | **Abandoned drafts.** The plan asks for a "cleanup job". | Saif | Mark them `abandoned`; **never delete the rows** — your database rule. Uploaded files of an abandoned draft are purged only after the retention period the client sets. |
| **D10** | **Claims in the partner API.** Not in the client plan; your standing rule says every capability is exposed. | Saif | `claims:read` in M4 (status and metadata by reference). `claims:write` (agencies filing on a customer's behalf) only if the client wants it — it's a new intake channel with its own validation questions. |
| **D11** | **Testing without Meta.** Meta credentials are still outstanding from M3, and the test report wants FR/EN screen recordings. | Saif | An **admin-only WhatsApp simulator** page that drives the real engine with a test number. Unblocks the recordings and the client's own UAT regardless of Meta, and is reusable in M5. Optional, ~half a day. |

---

## 3. What the client supplies — and where it goes

Your M3 rule: anything the client has to provide is entered in the admin panel. Every
pre-development item maps to a setting or to editable seed data, with a working default
so development is never blocked waiting for it.

| Client item | Stored as | Default until supplied |
|---|---|---|
| Claim categories and sub-categories | `claim_categories` (seeded, editable) | The 4 categories / 17 sub-categories in the client plan, FR + EN |
| Required documents per type | `claim_categories.required_documents` + `optional_documents` | Generic "any supporting document", optional |
| Case number format | `claims.number_format` | `SIN-{YYYY}-{SEQ:6}` |
| Priority rules | `claim_categories.default_priority` + `claims.urgent_keywords_fr/en` | Hospitalisation and medical repatriation → urgent; keyword list of medical emergency terms |
| Assistance card number format | `claims.card_number_pattern` (or none, per D3) | Accept the certificate number |
| Claims team notification destination | `claims.notification_email` | Empty → cases wait in the database for the M5 dashboard, per the client's own risk table |
| Document retention | `claims.document_retention_days` | Empty → keep indefinitely, no automatic purge |
| Declaration / consent wording | `claims.consent_text_fr/en` | Empty → consent step skipped |
| *Not in their list, but the plan needs it:* next steps and timeframe wording (Day 6) | `claims.next_steps_text_fr/en` | A neutral "our claims team will contact you" |
| *Not in their list:* filing window (D5) | `claims.filing_window_days` | Empty → no limit beyond the cover dates |
| *Not in their list:* unpaid policies (D4) | `claims.allow_unpaid_policies` | true, flagged |
| *Not in their list:* limits | `claims.max_documents`, `claims.max_file_mb` | 10 documents, 10 MB |
| Master switch | `claims.enabled` | **false** |

---

## 4. Day by day

### Day 1 — Data model & foundation

**Database schema** — new migrations, additive, guarded:

- [ ] **[new]** `claims` — claim reference, sale/policy ref, wa_number, customer ref, category, sub-category, description, incident date, incident country + city, sub-category fields (JSON), status, priority, flags (JSON), policy snapshot (JSON), language, submitted at, timestamps
- [ ] **[new]** `claim_categories` — code, parent code, name FR + EN, required document types, optional document types, extra fields (JSON: key, type, prompt FR/EN, validator), default priority, maps-to guarantee code, active, sort order
- [ ] **[new]** `claim_documents` — claim ref, storage key, original filename, declared mime, sniffed mime, size, sha256, document type, Meta media id, status (`stored` / `pending` / `failed`), uploaded at
- [ ] **[new]** `claim_status_history` — claim ref, from, to, changed at, changed by, note
- [ ] **[adjust]** `claim_sequences` — **reuse `policy_sequences`** with `seq_key = 'claim'` instead of a second allocator. Same atomic `LAST_INSERT_ID` pattern, already proven unique under concurrency. (No AUTO_INCREMENT — see SCHEMA.md for why.)
- [ ] **[new]** `claim_validation_attempts` — wa_number, identifier tried (hashed), outcome, at — the durable record behind rate limiting and abuse monitoring
- [ ] **[new]** `claim_notifications` — the outbox: claim ref, channel, destination, attempts, next attempt at, status, last error
- [ ] **[adjust]** `whatsapp_sessions.claim_id` + `parked_purchase` (JSON) for D7
- [ ] **[new]** Indexes: claim reference UNIQUE, sale id, wa_number, status + created_at
- [ ] **[new]** Seed all categories and sub-categories, bilingual, `INSERT IGNORE`
- [ ] **[reuse]** `claims.*` settings rows (§3), with `claims.enabled = false`

**Case reference allocation**

- [ ] **[reuse]** Atomic allocation under lock via `allocateNumber(conn, 'claim', format)`
- [ ] **[reuse]** Format per client specification — the existing `{YYYY} {YY} {MM} {SEQ:n}` tokens and validator
- [ ] **[reuse]** Collision test under concurrent load — the M3 test pattern, pointed at `claim`

**Status model**

- [ ] **[adjust]** `draft → submitted → under_review → closed`, plus **`abandoned`** as the terminal state for drafts (D9). The plan's four states have no way to end a draft that is never submitted.
- [ ] **[reuse]** Legal transitions enforced in code — the payments state machine pattern
- [ ] **[reuse]** Status history written on every change, in the same transaction

**Exit:** schema applied to staging, categories seeded in both languages, allocation proven unique under concurrency.

---

### Day 2 — Policy validation

**Validation logic**

- [ ] **[exists]** Lookup by policy number
- [ ] **[new]** Lookup by assistance card number (per D3 — likely the certificate number, also UNIQUE)
- [ ] **[exists]** Passport cross-check — via `passport_or_id_hash`, normalised the same way; the plaintext is never compared
- [ ] **[adjust]** Policy status: **cancelled** (`deleted_at`), **unpaid** (D4), **expired** — judged at the incident date (D5), not today
- [ ] **[adjust]** Coverage date check against the **issued snapshot** dates, which are authoritative since M3, not the live case
- [ ] **[new]** Both identifiers must resolve to the same sale

**Failure handling**

- [ ] **[new]** Not found — clear message, offer retry
- [ ] **[new]** Passport mismatch — the *same* generic message as not-found, so a stranger cannot tell a real policy number from a fake one
- [ ] **[new]** Expired — explain, offer the purchase flow (one tap back into the existing journey)
- [ ] **[new]** Cancelled — explain, raise the agent escalation marker
- [ ] **[new]** Retry limit — after N failures the number is locked out of validation for a window; logged

**Security**

- [ ] **[adjust]** Rate limiting per WhatsApp number, **durable** (database, survives restarts), separate from and much stricter than the 20/min flood limiter
- [ ] **[new]** Also limit per *policy number* — one policy being tried from many numbers is the other half of the guessing attack
- [ ] **[new]** Every failed attempt logged; identifiers stored hashed, never in clear
- [ ] **[new]** Nothing about the policy is shown before validation succeeds
- [ ] **[new]** The session receives only what the flow needs — sale id, policy number, holder's first name, cover dates. Never the passport, never the full snapshot

**Exit:** valid customers pass; invalid combinations rejected without leaking which field was wrong; guessing is rate limited and logged.

---

### Days 3–4 — Claims conversation flow

**Flow structure**

- [ ] **[adjust]** Entry point on the main menu — welcome switches from 3 buttons to a **list picker** (Buy · Claim · Track a claim · Question · Adviser), and the claims row appears **only when `claims.enabled` is true**
- [ ] **[new]** Keyword trigger — `SINISTRE`, `DÉCLARER`, `CLAIM`… using the loose-reading approach already proven for `ATTESTATION`
- [ ] **[new]** Policy validation step (Day 2)
- [ ] **[new]** Policy confirmation — "Policy AA-2026-000123, Saif, 18/10 → 01/12. Is this the right one?"
- [ ] **[reuse]** Category selection — buttons can't hold four options plus *back*, so this is a list picker too
- [ ] **[reuse]** Sub-category selection — `dynamic_list` driven by the selected category from the database
- [ ] **[reuse]** Incident date — `validateDateLoose` + check against cover dates
- [ ] **[reuse]** Incident location — country via the existing country lookup (FR/EN names), city as text
- [ ] **[new]** Free-text description with min/max length and a prompt that says so
- [ ] **[new]** Document upload step (Day 5)
- [ ] **[adjust]** Review screen — modelled on `quote_review`
- [ ] **[reuse]** Edit from review — the `review_edit` pattern
- [ ] **[new]** Declaration / consent — shown only if the client supplies wording
- [ ] **[new]** Final submission and case reference delivery (Day 6)

**Category-specific branching — all data, no hard-coded branches**

- [ ] **[new]** Travel — flight delay, trip cancellation, baggage delay, baggage loss, travel document loss, theft of belongings
- [ ] **[new]** Medical — medical treatment, hospitalisation, teleconsultation, medical repatriation
- [ ] **[new]** Accident — personal accident, temporary disability, permanent disability
- [ ] **[new]** Legal — third-party liability, legal assistance, bail advance, cash loss
- [ ] **[new]** Per-sub-category fields from `claim_categories.fields` (flight number for delay, hospital name for hospitalisation…)
- [ ] **[new]** Required-document prompt per sub-category from the same row

**Flow mechanics**

- [ ] **[reuse]** Session persistence and resume after drop-off
- [ ] **[adjust]** Back navigation — works as-is; history must not cross from claims back into purchase
- [ ] **[adjust]** `RESTART` restarts **the current journey**, clears the draft claim, and does not touch a parked purchase. Today it always returns to the purchase start
- [ ] **[new]** Abandoned-draft job — `scripts/abandonClaimDrafts.js`, cron, marks drafts older than the session timeout `abandoned` (D9)
- [ ] **[reuse]** Every string in `i18n/fr.json` + `en.json`; the parity test catches a missing key
- [ ] **[new]** Urgent-case detection — keyword lists from settings, matched on the description and sub-category; sets `priority = urgent`, raises the escalation marker, sends the adviser number immediately
- [ ] **[new]** Isolation (D7) — confirm-and-park from mid-purchase; refuse while a payment is pending

**Exit:** all four categories and all 17 sub-categories navigate correctly, each prompting its own fields.

---

### Day 5 — Document upload

**Media ingestion**

- [ ] **[adjust]** `parser.js` — `image` and `document` become a `media` message carrying the Meta media id, mime, sha256, filename, caption. **The purchase flow keeps answering them exactly as today**; only the claims journey accepts them
- [ ] **[new]** Download from Meta — `GET /{media-id}` for the short-lived URL, then fetch it with the access token
- [ ] **[new]** Type checked from the **file's first bytes**, not the declared type: `FF D8 FF` (jpg), `89 50 4E 47` (png), `%PDF` (pdf). Anything else is rejected, which also rules out executables and archives by construction
- [ ] **[new]** Integrity — compare against the sha256 Meta sends; a mismatch is a corrupted download
- [ ] **[new]** Size limit enforced (`claims.max_file_mb`), checked before the full download where Meta reports the size
- [ ] **[reuse]** Video, audio, stickers, location — rejected with the existing per-type messages

**Storage (per D2)**

- [ ] **[reuse]** Private — under `storage/`, which nothing serves
- [ ] **[new]** Path is a random identifier, never the claim reference or the customer's filename — a sequential claim number would make paths guessable, the same mistake avoided for certificates
- [ ] **[new]** Original filename preserved as metadata
- [ ] **[new]** Signed, short-lived retrieval URLs (HMAC, minutes) served only to authenticated admin requests
- [ ] **[adjust]** Encrypted at rest — AES-256-GCM, a buffer variant alongside the existing string one in `appCrypto.js`

**Upload flow**

- [ ] **[new]** Several files in sequence
- [ ] **[new]** Confirmation per file, **after** it is stored — never before
- [ ] **[new]** Running count ("3 documents received")
- [ ] **[new]** `TERMINÉ` / `DONE` to finish
- [ ] **[new]** Maximum per claim (`claims.max_documents`)
- [ ] **[new]** Skip where the sub-category's documents are optional
- [ ] **[new]** Prompt specific to the sub-category

**Failure handling**

- [ ] **[new]** Meta download failure — retry with backoff (the outbound client's retry pattern)
- [ ] **[new]** Storage failure — the document is recorded `pending` with its media id, the claim survives, a retry job re-fetches; the customer is told it will be attached and can also resend
- [ ] **[new]** Oversized — message states the limit and suggests a photo instead of a scan
- [ ] **[new]** Corrupted — hash mismatch or a file that fails its own format check
- [ ] **[new]** Document at the wrong step — attached to the draft and acknowledged, not rejected

**Security**

- [ ] **[new]** Scan hook — no-op by default, ClamAV adapter if present (D8)
- [ ] **[new]** No executables or archives — enforced by the magic-byte allowlist
- [ ] **[new]** Retrieval requires an admin JWT; never a public link

**Design note.** Downloading and storing happen in the **controller, before the engine
runs**, and the engine receives "document stored" or "document failed". The engine
stays free of side effects — the rule it has followed since M2 — and the customer is
never told a file arrived that was not actually saved.

**Exit:** images and PDFs upload reliably, several per claim, every failure mode handled without losing the claim.

---

### Day 6 — Case creation & notification

**Case creation**

- [ ] **[new]** Only on the final confirmed submission
- [ ] **[reuse]** Reference allocated atomically, inside the submission transaction
- [ ] **[reuse]** Policy snapshot at submission — a copy of the certificate's issued snapshot, plus the validation outcome and flags (D4, D5, D6)
- [ ] **[new]** Documents already linked to the draft are carried to the case
- [ ] **[new]** Priority per the sub-category's default, raised by urgent keywords
- [ ] **[new]** Status `submitted`, history initialised (`draft → submitted`)

**Customer confirmation**

- [ ] **[new]** Case reference
- [ ] **[new]** Summary of what was submitted
- [ ] **[new]** Next steps and timeframe — client wording (§3), neutral default
- [ ] **[reuse]** Both languages

**Internal notification**

- [ ] **[new]** Email to `claims.notification_email` through an **outbox**, sent by `scripts/sendClaimNotifications.js` on cron
- [ ] **[new]** Urgent cases flagged distinctly (subject prefix, sent first)
- [ ] **[new]** Content: reference, category, customer name, policy number, priority. **No passport number, no documents** in the email — a link to the admin instead. Email is not a secure channel
- [ ] **[new]** A failed send never blocks the case — retried with backoff, and surfaced in alerts after repeated failure
- [ ] **[reuse]** No destination configured → the case simply waits in the database for the M5 dashboard (the client's own mitigation)

**Case lookup**

- [ ] **[new]** `SUIVI <reference>` / `TRACK <reference>` and a menu row
- [ ] **[new]** Ownership check — the case must belong to the number asking, by **exact** match (the discipline used for certificate resend; never a suffix match)
- [ ] **[reuse]** Status message in both languages

**Exit:** a submitted claim produces a persisted case with documents, a customer confirmation and an internal notification.

---

### Days 7–8 — Internal testing

**Functional** — automated, in the conversation harness unless noted

- [ ] Every sub-category across all four categories, end to end (17 scenarios)
- [ ] Each sub-category's required fields prompted correctly
- [ ] Validation — valid, invalid, expired, cancelled, passport mismatch
- [ ] Rate limiting on repeated failures, including across a restart
- [ ] Incident date outside cover rejected
- [ ] Documents — single, multiple, zero where optional
- [ ] Unsupported types rejected cleanly (real fixture files with misleading extensions)
- [ ] Oversized file rejected with the limit stated
- [ ] Review screen matches submitted data
- [ ] Edit from review, every field
- [ ] Back navigation from every step
- [ ] Restart mid-flow clears the draft
- [ ] Resume after drop-off at every step
- [ ] Language switch mid-flow
- [ ] Urgent keyword raises priority

**Isolation**

- [ ] Claims never interfere with purchase
- [ ] A customer mid-purchase cannot be dropped into claims by accident
- [ ] A customer waiting on a payment cannot enter claims
- [ ] No session state leaks between the two journeys
- [ ] Purchase regression — the full existing suite (currently 293 unit + 77 integration) re-run and passing

**Concurrency and integrity**

- [ ] Concurrent submissions → unique references
- [ ] Simultaneous uploads to one claim → every file recorded once
- [ ] Abandoned claims leave no orphaned document rows

**Data verification**

- [ ] Everything submitted retrievable and correct in the database
- [ ] Documents decrypt and match the original sha256
- [ ] Status history accurate
- [ ] Policy snapshot captured at submission

**Test report** — the acceptance artefact

- [ ] Test matrix, every category and sub-category, pass/fail — generated from the test run, not typed by hand
- [ ] Failure scenario results
- [ ] Screen recordings, FR and EN — **yours to record**, on Meta's test number in staging or on the simulator (D11)
- [ ] Known limitations
- [ ] Delivered to the client

**Exit:** full matrix passing in staging, purchase regression clean, report delivered and accepted.

---

## 5. Additions the client plan does not list

These follow from your standing rules or from the audit; each is small.

| Addition | Why | Size |
|---|---|---|
| `claims.enabled` flag, wired from Day 1 | The client plan's own risk mitigation; also how claims stay invisible in production until M5 | — |
| **Claims Settings** admin screen | Your rule: client inputs go in the admin panel. Same pattern as Payment Settings | ½ day |
| **Category editor** (names, documents, fields, priority, active) | The client plan promises "category changes are data edits" — they need a screen to make them | ½ day |
| Partner API `claims:read` (D10) | Your rule: every capability is exposed | ½ day |
| WhatsApp simulator (D11, optional) | Meta is still outstanding; recordings are a deliverable | ½ day |
| API.md, openapi, Postman, SCHEMA.md, RUNBOOK, partner zip | Same discipline as M2/M3 | in the above |
| Two cron jobs (notifications, abandoned drafts) | Day 3 and Day 6 | in the above |
| Staging setup guide | Server work is yours; I write the steps (D1) | — |

**Honest estimate:** the client plan's 8 days, plus about 1½–2 days for the screens and
API above. If the client wants M4 held to 8 days, the category editor and simulator are
the two that can move to M5 without weakening intake.

---

## 6. Migrations

| File | Adds |
|---|---|
| `m4_01_claim_tables.sql` | `claims`, `claim_documents`, `claim_status_history` |
| `m4_02_claim_categories.sql` | `claim_categories` + bilingual seed of 4 categories / 17 sub-categories |
| `m4_03_claim_security.sql` | `claim_validation_attempts` |
| `m4_04_claim_notifications.sql` | `claim_notifications` outbox |
| `m4_05_whatsapp_claim_link.sql` | `whatsapp_sessions.claim_id`, `parked_purchase` |
| `m4_06_claim_settings.sql` | `claims.*` settings, `claims.enabled = false` |

All guarded, all re-runnable, verified against a copy of the live schema with existing
data before they reach staging.

---

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| No staging environment | Plan's key constraint cannot be met | D1 — staging subdomain + Meta test number before Day 7 |
| Meta still not live | No real-device testing, no recordings | D11 simulator; Meta's free test number in staging |
| Category list changes after build | Rework | Categories are seeded data with an editor |
| Claims break the live purchase flow | Incident on a live pilot | Behind `claims.enabled` (off); purchase journey's behaviour on media unchanged; full regression on Day 8 |
| Meta media download failures | Lost documents | Retry with backoff; `pending` document + re-fetch job; customer can resend |
| Storage temporarily down | Lost documents | The claim and the media id persist; files re-fetched later |
| Required-document rules not supplied | Generic prompts | Generic default, editable without code |
| Large PDFs | Customer cannot submit evidence | Limit stated in the prompt; photo suggested |
| No notification destination | Cases with nobody informed | Outbox holds them; M5 dashboard shows them |
| Passport guessing against policy numbers | Disclosure of a stranger's cover | Both identifiers must match; generic failure message; durable per-number **and** per-policy rate limits; attempts logged |
| Document paths guessable | Disclosure of medical documents | Random storage keys, not claim references; encrypted; admin-only signed URLs |
| Claim filed after policy end rejected wrongly | Valid claims turned away | D5 — judged at the incident date |
| No agent interface until M5 | Cases can't be worked | Expected — M4 is intake only |

---

## 8. Out of scope (unchanged from the client plan)

Deferred to M5: admin dashboard (conversations, claims, policies, documents), dormant
production deployment, feature-flag activation control, handover.

Not in the contract: adjudication or approval, payout, travel assistance workflows, live
agent chat, email/SMS channels to the customer, status updates pushed to the customer.
