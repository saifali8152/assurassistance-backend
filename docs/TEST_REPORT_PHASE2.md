# Phase 2 (M4 claims + M5 admin) — test report

**Date:** 13 November 2026 · **Code:** the `backend/` and `frontend/` in the
project folder as of this date · **Database:** a throwaway MariaDB 10.11 built from
`database_dump.sql` + every legacy migration + `npm run migrate` (never the live
database).

## Result

| Suite | Tests | Passed | Failed |
|---|---|---|---|
| Backend unit (`npm test`) | 422 | 422 | 0 |
| Backend integration (`npm run test:integration`, real DB + real HTTP) | 174 | 174 | 0 |
| Frontend type-check (`tsc -b`) and production build (`vite build`) | — | clean | — |
| Lint on every Phase 2 screen (`eslint`) | — | clean | — |
| Click-through in a real browser (Chromium, scripted) | 31 checks | 31 | 0 |

Migrations were applied to the throwaway database, then applied a **second
time**: the second run reports *up to date* (they are re-runnable). The
integration suite was also run twice on the same database without failures.

## What the automated tests cover

**Claims on WhatsApp (M4)**
- Feature switch: off by default, fail-closed if unreadable, allowlisted test
  numbers only while off, cached 10 s.
- Policy check: policy/certificate number + passport (blind index), wrong-pair
  lockout per number and per policy, expired / not-yet-started / unpaid /
  cancelled / soft-deleted policies, filing window, imported policies.
- The conversation: every step in French and English, typed and tapped answers,
  dates in several formats, category-specific questions (text, number with
  min/max, date, choice, max length), urgent-word detection, resume a draft,
  switching from a purchase into a claim and back (the purchase is parked, not
  lost), *SUIVI* status lookup, commands never read from a button title.
- Documents: JPG/PNG/PDF accepted by their real content (magic bytes), other
  types refused, size and count limits, encrypted at rest, a file sent "too
  early" is attached rather than refused, failed downloads retried with backoff.
- Submission: reference numbering, priority, status history, notification
  outbox, abandoned drafts, retention purge (files only, rows kept).

**Admin (M5)**
- Permissions: built-in roles unchanged, admin has everything, "Claims handler"
  template, custom roles, deactivation, audit of every role change, login
  lockout after 5 wrong passwords.
- Claims management: list ordering (urgent open first), masking, test claims
  hidden unless asked, detail view audited, status changes (only
  submitted → under review → closed), signed document links expiring after
  5 minutes.
- Imported policies: CSV and Excel import with preview, row errors, duplicates,
  passports encrypted, exact-passport search, status change; never counted as
  sales.
- Certificate re-send on WhatsApp: right number, 24-hour template rule, refusal
  while WhatsApp is not connected.
- Simulator: a full claim with a document while claims are **off**, and proof that
  no case, traveller, sale, invoice or certificate row is written.

**Partner API**
- `claims:read` required; an agency key sees only its own policies' claims; test
  claims and drafts never returned; no description, document, passport or phone in
  any response; bad filters answer `400`.
- **New in this pass:** claim conversations are never returned by
  `/whatsapp/sessions*` to an API key or to staff without *View claims* (see
  "Found and fixed" below).

**Safety of live data**
- Every existing user keeps the same access after the migration.
- The simulator and the claims module write nothing into `cases`, `travellers`,
  `sales`, `invoices` or `certificates`.
- Soft-deleted policies still download their certificate (logic unchanged;
  checked by hand in this pass: soft-delete a policy, then download its
  certificate → 200, PDF). The re-send button is hidden for a soft-deleted policy.

## Click-through (real browser, as admin, handler, supervisor, agent)

| Area | Checked | Result |
|---|---|---|
| Claim detail | PDF, PNG and JPG open in the in-page preview; download from the row and from the preview; every view in the audit log | Pass |
| Status | Start review with a note → under review; close → closed; history written | Pass |
| Activation | Switch on only after typing ON; switch off with OFF; flag stored | Pass |
| Test numbers | Add and remove a number | Pass |
| Imported policies | CSV: 2 valid + 1 error previewed, 2 written · Excel: unknown column flagged, 1 written · Add one (passport stored encrypted) · search by exact passport | Pass |
| Categories | Edit a sub-category label and save | Pass |
| Settings | Change a value, "Save 1 change(s)", stored | Pass |
| Roles | Create a custom role, assign it, audit tab lists changes | Pass |
| Simulator | A full test claim with a PDF upload, start to finish (17 steps) | Pass |
| Conversations | Claim journey column; a claim conversation opens with links to the claim's files | Pass |
| Idle timeout | Warning after ~29 minutes; signed out at 30 | Pass |
| Re-send certificate | Dialog opens; clear message while WhatsApp is not connected | Pass |
| Access | Claims handler: Claims only (settings, activation, roles, imports, simulator refused) · Supervisor and agent: no claims screens, no new menu items | Pass |
| French | Every new screen fully translated | Pass |
| Tablet (820 px) | Every new screen | Pass |

## Found and fixed during this pass

| # | Finding | Fix |
|---|---|---|
| 1 | Opening a new screen's address directly sent the admin to "unauthorized" (permissions loaded before the session was restored) | Permissions wait for the session and are keyed to the signed-in user |
| 2 | New screens and dialogs inherited the panel's centred text; dropdowns had no border | Left-aligned; field styles fixed for every new screen and dialog |
| 3 | Filters looked plain | New filter panel: labelled fields, date range, switch for test claims, removable filter chips, clear-all |
| 4 | Simulator state panel unstyled; journey shown as a code; "In progress" after the claim was closed | Redesigned panel, translated journey, "Finished" state |
| 5 | Dialogs did not close with Escape | Escape closes every dialog |
| 6 | Conversations: centred text, customer messages without a bubble | Left-aligned, bubbles added |
| 7 | **Partner keys with `whatsapp:read` (and any signed-in agent) could read claim conversations** — descriptions and passports — through `/whatsapp/sessions*`, contrary to "status only" | Claim conversations are filtered out for API keys and for staff without *View claims*; claim messages are removed from purchase transcripts; 5 new integration tests |
| 8 | `GET /api/claims?updatedSince=<invalid>` silently returned an empty list | `400 invalid_parameter`; same for an unsupported `status`; tests added |
| 9 | `claims:read` appeared under "Other" in the API key scope picker | Own "Claims" group, FR/EN |
| 10 | The partner zip's `CREDENTIALS.txt` contained a real `aas_live_…` key | Replaced with a blank template; **the key must be revoked** (deploy guide §10) |
| 11 | **Any signed-in user (an agent included) could read every WhatsApp transcript and send a WhatsApp message to any number** through `/api/whatsapp/sessions*`, `/stats` and `POST /messages` (older than Phase 2) | With a user login these are now main-admin only; partner keys unchanged (scopes). The claim page shows the conversation link to admins only. Tests: agent, insurer supervisor and Claims handler get 403 everywhere; admin sees all; `/status` stays open |

## Known limits (not defects)

- **WhatsApp is not connected yet**, so claims from a real phone, document
  download from Meta and the re-send to a customer were exercised through the
  simulator and tests, not end-to-end with Meta. Do this with a test number after
  connecting (deploy guide §8).
- The PDF preview relies on the browser's built-in PDF viewer (all desktop
  browsers have one).
- `openapi.yaml` carries 179 lint errors that predate Phase 2 (none in the new
  claims sections).

## How to re-run

```bash
cd backend
npm test
# throwaway DB only — never the live one
IT_DB_NAME=<throwaway> IT_DB_USER=… IT_DB_PASSWORD=… SETTINGS_ENCRYPTION_KEY=<64 hex> npm run test:integration
cd ../frontend && npx tsc -b && npm run build
```
