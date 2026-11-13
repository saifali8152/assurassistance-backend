# Phase 2 — Claims, Admin Dashboard & Dormant Deployment (M4 + M5)

**Status:** planned, all decisions settled — ready to build
**Source:** `development-plan-phase-2-m4-m5.md` (client plan, 14 working days)
**Supersedes:** `CLAIMS_MODULE_PLAN.md` (the M4-only draft)
**Build mode:** directly in the repo; nothing committed or pushed

Tags: **[exists]** used as-is · **[reuse]** existing machinery pointed at a new job ·
**[adjust]** existing code that changes · **[new]** written from scratch

---

## 0. Ground rules

1. **Live data is read, never changed.** The claims module only *reads* `sales`,
   `cases`, `travellers`, `certificates`. It never updates or deletes a row in them.
   Everything it writes goes into new tables. The one live table it adds rows to is
   `whatsapp_sessions` (new rows for claim conversations) — never touching existing ones.
2. **Migrations are additive and guarded** (`m4_*`, `m5_*`): no `DROP`, no narrowing
   `MODIFY`, no destructive `UPDATE`; re-runnable; verified against a copy of the live
   schema with data before they ship.
3. **Tests never touch the live database** — they run against a throwaway database
   (`IT_DB_NAME`).
4. **The purchase flow does not change behaviour.** Claims sit behind `claims_enabled`,
   off from Day 1.
5. **Everything client-specific is managed in the admin panel**, with a working default.
6. **The existing admin panel is extended** — no second dashboard, no second login system.
7. **Every new capability goes into the partner API docs**, and the partner package and
   zip are rebuilt.

---

## 1. Decisions (all settled)

| # | Decision |
|---|---|
| D1 | **No separate staging.** Automated suite on a throwaway DB, then production behind the flag with allowlisted numbers. |
| D2 | **Documents on our server**, AES-256-GCM encrypted, under `storage/claims/` (not web-served). |
| D3 | **Assistance card number is an admin setting**: "same as certificate number", or "separate" with its own pattern. |
| D4–D6 | **Policy rules are admin settings**: expiry judged at incident date (default) + optional filing window; unpaid policies allowed / refused (default allowed, flagged); claim type not on plan → flag (default) / refuse. |
| D7 | **Isolation**: mid-purchase → confirm, purchase draft parked; waiting on a payment → claims refused until it settles. |
| D8 | **No ClamAV.** Scan hook is a documented no-op; jpg/png/pdf magic-byte allowlist blocks executables and archives. |
| D9 | **Abandoned drafts are marked, never deleted.** Files purged only under the admin-set retention period. |
| D10 | **Partner API: `claims:read`, status only** — never documents or passport data. |
| D11 | **WhatsApp simulator** in the admin panel — Meta is not live yet; this unblocks testing and acceptance. |
| D12 | **Permissions system**: the 4 existing roles keep working unchanged as built-in roles; new permissions gate **only the new features**; the main admin can create custom roles and assign them. |
| D13 | **Imported policies are claim-validation records only** — labelled "imported", excluded from sales, ledger, commissions and partner invoices. Test policies for production testing go in this way too. |
| D14 | **Test claims** (from allowlisted numbers) are flagged and hidden from the normal claims list by default. |

Parked with the client until the work is finished: sign-off contact, deploy heads-up,
whether external policies exist, Meta setup timeline. Consent wording is entered by the
client in the admin panel; the step is skipped while it is empty.

---

## 2. Milestone 4 — Claims (Days 1–8)

### Day 1 — Feature flag, data model, foundation

**Feature flag** (built first)
- [x] **[new]** `feature_flags` — key, enabled, updated by, updated at; `claims_enabled` = **false**
- [x] **[new]** `feature_flag_allowlist` — WhatsApp numbers that may use claims while off
- [x] **[new]** `feature_flag_audit` — every change: who, when, old → new
- [ ] **[new]** Check at every entry point — menu row, keyword, case lookup, simulator
- [ ] **[new]** Off: claims row hidden from the menu; keyword → neutral "coming soon"
- [x] **[new]** Cached with a short TTL, cleared on change — toggles apply without restart

**Schema**
- [x] **[new]** `claims` — reference, sale ref or imported-policy ref, wa_number, category, sub-category, incident date / country / city, description, extra fields (JSON), status, priority, flags (JSON), policy snapshot (JSON), language, is_test, submitted at, timestamps
- [x] **[new]** `claim_categories` — code, parent, name FR/EN, required docs, optional docs, extra fields (JSON), default priority, guarantee code, active, sort order
- [x] **[new]** `claim_documents` — claim ref, random storage key, original filename, declared + sniffed mime, size, sha256, document type, Meta media id, status (`stored`/`pending`/`failed`)
- [x] **[new]** `claim_status_history` — from, to, changed by, note, at
- [x] **[reuse]** Sequences — `policy_sequences` with `seq_key = 'claim'`, not a second allocator
- [x] **[new]** `external_policies` — imported policies (D13): number, card number, holder, passport (encrypted + blind index), cover dates, product, status, source, import batch
- [x] **[new]** `claim_validation_attempts`, `claim_notifications` (outbox)
- [x] **[adjust]** `whatsapp_sessions.claim_id`, `parked_purchase`
- [x] **[new]** Seed — the 4 categories / 17 sub-categories in the client plan, FR + EN
- [x] **[new]** Claims settings — card-number mode, number format, policy rules (D4–D6), notification emails, retention, max docs/size, urgent keywords FR/EN, confirmation and consent text FR/EN

**Reference + status**
- [x] **[reuse]** Atomic allocation via `allocateNumber(conn, 'claim', format)`; concurrency test
- [x] **[adjust]** `draft → submitted → under_review → closed`, plus `abandoned` (D9); transitions enforced; history in the same transaction

### Day 2 — Policy validation
- [x] **[exists]** Lookup by policy number · **[new]** by card number (per D3 setting) · **[new]** against imported policies
- [x] **[exists]** Passport cross-check via the blind index — plaintext never compared
- [x] **[adjust]** Status: cancelled (`deleted_at`), unpaid (setting), expired at the **incident date** (setting); dates from the **issued snapshot**
- [x] **[new]** Both identifiers resolve to the same policy
- [x] **[new]** Not found / passport mismatch → the **same** generic message
- [ ] **[new]** Expired → explain + one tap to buy; cancelled → explain + agent flag *(outcomes + dates returned; wording and buttons land with the conversation, Days 3–4)*
- [x] **[new]** Retry limit per session → lockout; **durable** rate limit per number **and** per policy; attempts logged with identifiers hashed
- [x] **[new]** Nothing about the policy shown before success; session gets only what the flow needs

### Days 3–4 — Conversation flow
- [ ] **[adjust]** Main menu → list picker (Buy · Claim · Track · Question · Adviser); claim rows only when flag/allowlist allows
- [ ] **[new]** Keyword trigger (`SINISTRE`, `CLAIM`…), loose reading as for `ATTESTATION`
- [ ] **[new]** Validation → policy confirmation → category (list) → sub-category (list from DB) → incident date (checked against cover) → location (country lookup + city) → **extra fields from the category row** → description (length guidance) → documents → review → edit any field → consent (if text set) → submit
- [ ] **[new]** All 17 sub-categories driven by data — no hard-coded branches
- [ ] **[reuse]** Resume after drop-off; FR/EN strings with parity test; language switch
- [ ] **[adjust]** `BACK` never crosses into purchase; `RESTART` restarts the current journey and clears the draft only
- [ ] **[new]** Abandoned-draft job (cron) — marks, never deletes
- [ ] **[new]** Urgent keywords → `urgent` priority + escalation marker + adviser number sent
- [ ] **[new]** Isolation per D7

### Day 5 — Documents
- [ ] **[adjust]** `parser.js`: image/document → `media` with Meta id, mime, sha256, filename, caption — **purchase flow still answers them exactly as today**
- [ ] **[new]** Download **in the controller, before the engine runs**: Graph media lookup → fetch with token → retry with backoff
- [ ] **[new]** Type from first bytes (jpg/png/pdf); sha256 vs Meta; size + count limits from settings
- [ ] **[new]** Encrypted to `storage/claims/<random key>`; original name as metadata
- [ ] **[new]** Multi-file, confirmation per file **after** it is stored, running count, `TERMINÉ`/`DONE`, skip when optional, prompt per sub-category
- [ ] **[new]** Storage failure → document `pending` with its media id, claim kept, re-fetch job; customer may resend
- [ ] **[new]** Oversized / corrupted / wrong type → clear message; file at the wrong step → attached
- [ ] **[new]** Scan hook (no-op, documented)

### Day 6 — Case creation, notification, lookup
- [ ] **[new]** On confirmed submit only: reference, snapshot, documents carried, priority, `submitted` + history — one transaction
- [ ] **[new]** Customer confirmation — reference, summary, next steps (admin-editable text, default supplied)
- [ ] **[new]** Outbox → email to admin-set recipients via cron; urgent first and marked; **no passport or documents in email**; retried, never blocks the case; nothing configured → dashboard only
- [ ] **[new]** `SUIVI <ref>` / `TRACK <ref>` — exact-number ownership check

### Days 7–8 — Testing (M4 acceptance)
- [ ] Every sub-category end to end; validation (valid, invalid, expired, cancelled, mismatch, imported); lockout; out-of-cover date; documents (one, many, none, wrong type, oversized, corrupted); review and edit every field; back and restart from every step; resume at every step; language switch; urgent detection
- [ ] Flag off → invisible; allowlisted → works; on → everyone; toggle without restart
- [ ] Isolation: no leakage between journeys; payment-pending refusal; **full purchase regression** (currently 294 unit + 77 integration)
- [ ] Concurrent submissions and uploads; no orphaned documents
- [ ] **Test report** — matrix generated from the test run, failure scenarios, FR/EN recordings via the simulator, known limitations

---

## 3. Milestone 5 — Admin dashboard (Days 9–14)

The admin panel already exists (React/Vite/Tailwind/TS, JWT, roles, FR/EN, logo, password
reset, activity log, policies, payments, conversations). M5 extends it.

### Day 9 — Access control
- [ ] **[exists]** Login, JWT (1 h), logout, password reset, server-side role checks, layout, FR/EN
- [ ] **[new]** Permissions (D12) — `access_roles`, `access_role_permissions`, `users.access_role_id`. Built-in roles reproduce today's behaviour exactly; admin creates custom roles from permissions: `claims.view`, `claims.update_status`, `claims.documents`, `claims.settings`, `claims.categories`, `claims.activate`, `claims.allowlist`, `policies.import`, `simulator.use`. A **"Claims handler"** template role ships ready to assign
- [ ] **[new]** Roles & permissions screen
- [ ] **[adjust]** Per-account lockout after repeated failed logins (IP limiter already exists)
- [ ] **[adjust]** Idle timeout in the UI on top of the 1 h token
- [ ] **[new]** Audit of **views** for claims and documents, plus every flag, role and allowlist change

### Day 10 — Policies & payments
- [ ] **[exists]** Policies list, filters, pagination, detail, certificate view/download
- [ ] **[new]** Imported policies in the list, labelled; single-add form + **CSV/Excel import** with template, preview and per-row errors; never counted financially (D13)
- [ ] **[new]** Exact search by passport (blind index)
- [ ] **[adjust]** Phone and passport masked in lists, full on detail only
- [ ] **[new]** "Re-send certificate on WhatsApp" button — reuses `deliverCertificate` (works once Meta is live)
- [ ] **[exists]** Payments view, filters, failed/expired visible

### Day 11 — Claims management
- [ ] **[new]** List — reference, customer, policy, category, priority, status, date; urgent pinned and flagged; search; filters; test claims hidden by default
- [ ] **[new]** Detail — all fields, extra fields, snapshot, flags, description
- [ ] **[new]** Documents panel — in-browser preview of images and PDFs, download; signed short-lived URLs only; every view audited
- [ ] **[new]** Status update with note; history shown
- [ ] **[new]** Claims section marked "inactive" while the flag is off (test claims still visible to admin)
- [ ] **[new]** **Claims settings** screen and **category editor** (names, documents, extra fields, priority, active)

### Day 12 — Conversations, activation, simulator, testing
- [ ] **[exists]** Conversations list, search, transcript · **[adjust]** journey column, media shown as links to stored files
- [ ] **[new]** Activation panel — state, last changed by/when, confirmation stating the effect, instant, audited, `claims.activate` only
- [ ] **[new]** Allowlist management
- [ ] **[new]** **WhatsApp simulator** (D11) — admin-only chat that drives the real engine with a test number
- [ ] Every role against every screen and endpoint; search/filter/pagination; document preview per type; laptop + tablet; Chrome, Safari, Edge

### Day 13 — Dormant production deployment (your server steps; I supply the guide)
- [ ] Backup immediately before; migrations reviewed additive-only; off-peak
- [ ] **`claims_enabled` = false verified after deploy**; menu shows no claims row; keyword neutral for the public
- [ ] Allowlisted / simulator claim end to end in production, against an imported test policy
- [ ] `storage/claims/` created, private, encrypted, in the backup
- [ ] Purchase smoke test; alerts extended to claims; rollback steps written

### Day 14 — Handover
- [ ] Guides: admin & claims handler, activation, allowlist, categories/documents/priority, roles & permissions, policy import, troubleshooting
- [ ] API.md, openapi, Postman (`claims:read`), SCHEMA.md, RUNBOOK, partner zip
- [ ] Client session items — parked until Meta is live (see §1)

---

## 4. Migrations

| File | Adds |
|---|---|
| `m4_01_feature_flags.sql` | `feature_flags`, `feature_flag_allowlist`, `feature_flag_audit`; `claims_enabled = false` |
| `m4_02_claim_tables.sql` | `claims`, `claim_documents`, `claim_status_history` |
| `m4_03_claim_categories.sql` | `claim_categories` + FR/EN seed |
| `m4_04_external_policies.sql` | `external_policies` |
| `m4_05_claim_security.sql` | `claim_validation_attempts` |
| `m4_06_claim_notifications.sql` | `claim_notifications` |
| `m4_07_whatsapp_claim_link.sql` | `whatsapp_sessions.claim_id`, `parked_purchase` |
| `m4_08_claim_settings.sql` | `claims.*` settings with defaults |
| `m5_01_access_roles.sql` | `access_roles`, `access_role_permissions`, `users.access_role_id`, built-in + "Claims handler" roles |
| `m5_02_admin_audit.sql` | `admin_audit_log` (actor, action, entity, id, ip, at) |
| `m5_03_login_lockout.sql` | `users.failed_login_count`, `users.locked_until` |

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Phase 2 breaks the live purchase flow | Flag from Day 1; live tables read-only; media behaviour unchanged for purchase; full regression Day 8 + smoke test Day 13 |
| Test data pollutes live reporting | Test policies are imports (excluded financially); test claims flagged and hidden |
| Meta not live by acceptance | Simulator covers testing and recordings; real-phone steps parked with the client |
| Passport guessing | Both identifiers must match; one generic message; durable per-number and per-policy limits; attempts logged |
| Claim documents exposed | Random storage keys, encrypted, admin-only signed URLs, views audited |
| Permissions change disturbs existing users | Built-in roles reproduce today exactly; permissions gate only new features |
| Category list changes | Data plus an editor — no code change |
| Dashboard scope grows | Fixed to this list; additions quoted separately |

## 6. Out of scope

Adjudication and payout, assistance workflows, live agent chat, email/SMS to customers,
reports/KPIs/exports, pushed status updates, CRM, refunds/cancellations/renewals.
