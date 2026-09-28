# AssurAssistance API — Security Model

This document describes how the backend protects its data and what 3rd-party
integrators are expected to do on their side. It complements
[`INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md) and the spec in
[`openapi.yaml`](./openapi.yaml).

---

## 1. Threat model

We assume:

* The backend is accessed over TLS 1.2+ (Hostinger / nginx terminates TLS).
* Credentials may be lost or leaked.
* Integrators may be compromised, requiring rapid revocation.
* The network may inject malicious payloads (XSS, SQLi).
* Attackers will brute-force public endpoints (login, password reset).

We protect against these with: short-lived JWTs, hashed API keys, per-key IP
allowlists, scope-restricted permissions, audit logging, server-side rate
limiting, parameterised SQL, and bcrypt password hashing.

---

## 2. Authentication

### Two interchangeable bearer schemes

Both schemes use the same header:

```
Authorization: Bearer <token>
```

The backend auto-detects which by looking at the token prefix:

| Token prefix | Type | Verified by |
|---|---|---|
| `aas_live_…` | API key | SHA-256 lookup in `api_keys.key_hash` |
| anything else | JWT | `jsonwebtoken.verify` using `JWT_SECRET` |

### JWTs (in-house web app)

Issued by `POST /api/auth/login`. Payload:

```json
{ "id": 42, "email": "agent@example.com", "role": "agent" }
```

* Default expiry: `JWT_EXPIRES_IN` (recommend `24h`; lower in
  high-sensitivity deployments).
* No refresh-token flow — clients re-login when the JWT expires.
* Signing algorithm: HS256 with `JWT_SECRET` (≥ 32 chars).

### API keys (3rd-party server-to-server)

Generated server-side as:

```
aas_live_<48 base64url chars>     (≈ 288 bits of entropy)
```

Stored as:

* `key_prefix` — first ~12 characters in clear (for display).
* `key_hash` — SHA-256 hex digest of the full secret. **The full secret is never persisted.**

Each key is bound to:

| Field | Purpose |
|---|---|
| `owner_user_id` | Whose visibility the key inherits (an agent's key only sees the agent's cases). |
| `scopes` | JSON array of allowed actions (e.g. `["cases:read", "cases:write"]`). |
| `ip_allowlist` | Optional CSV of IPs / CIDRs. |
| `rate_limit_per_min` | Optional per-key cap; default is `API_KEY_DEFAULT_RPM` (120). |
| `expires_at` | Optional hard expiry. |
| `status` | `active` or `revoked`. |

The full secret is returned **only at creation time** by
`POST /api/admin/api-keys` and at rotation by
`POST /api/admin/api-keys/:id/rotate`.

---

## 3. Authorization

Authorization is layered:

```
┌─ JWT or API key (proves who you are) ──────────────────────────────┐
│                                                                    │
│  ┌─ Role check (admin, sub_admin, insurer_supervisor, agent) ────┐ │
│  │                                                               │ │
│  │  ┌─ Scope check (API keys only) ───────────────────────────┐  │ │
│  │  │                                                         │  │ │
│  │  │  ┌─ Visibility filter (controller / SQL WHERE) ──────┐  │  │ │
│  │  │  │  e.g. agent-key user only sees own cases           │  │  │ │
│  │  │  └────────────────────────────────────────────────────┘  │  │ │
│  │  └─────────────────────────────────────────────────────────┘  │ │
│  └───────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

1. **Authentication** — middleware sets `req.user` and (for API keys) `req.apiKey`.
2. **Role gate** — `adminOnly`, `adminOrSubAdmin`, `adminOrAgencyManager` for sensitive endpoints.
3. **Scope gate** — `requireScope("cases:write")` for API-key calls only
   (JWT users are gated by role instead).
4. **Visibility filter** — list controllers call `getAgentVisibilityIds()` and/or
   filter by `catalogue.partner_insurer` so a sub-admin, insurer supervisor, or
   agent only sees rows in their hierarchy / insurer scope.

---

## 4. Rate limiting

Two layers run on every request:

| Layer | Scope | Default |
|---|---|---|
| `express-rate-limit` (per IP) | All `/api/*` | 600 / 15 min |
| Per-key sliding window | API-key requests only | 120 / min |
| Auth-burst limiter | `/auth/login`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/verify-reset-code` | 20 / 15 min |

Per-IP responses use the standard `RateLimit-*` headers. Per-key responses
also set `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

When you hit a limit you get HTTP `429` with `code: "rate_limited"`. Retry
with exponential backoff respecting the `Reset` header.

> For a multi-instance deployment, swap the in-process counter in
> `middlewares/apiKeyMiddleware.js` for Redis `INCR` + `PEXPIRE` to share
> state across replicas.

---

## 5. Transport + headers

* **TLS** terminated at the edge proxy. The app itself listens on HTTP — keep
  the proxy in front.
* **Helmet** sets:
  * `Strict-Transport-Security: max-age=15552000; includeSubDomains`
  * `X-Content-Type-Options: nosniff`
  * `X-DNS-Prefetch-Control: off`
  * `X-Download-Options: noopen`
  * `X-Frame-Options: SAMEORIGIN`
  * `Referrer-Policy: no-referrer`
  * `Cross-Origin-Resource-Policy: cross-origin` (so PDFs/logos can be embedded by partners).
* **CORS** — origin allowlist controlled by `CORS_ORIGINS` (CSV) or `FRONTEND_URL`.
  Server-to-server traffic (no `Origin` header) is always allowed.
* **Content-Length** capped at 10 MB on JSON/urlencoded; multipart upload at 2 MB.

---

## 6. Input handling

* Every JSON body is run through a string-sanitiser that strips `<script>` tags
  and `javascript:` URLs. This is a belt-and-braces measure — clients should
  still validate input on their side.
* All SQL is parameterised via `mysql2` placeholders. No string concatenation
  with user input.
* File uploads only accept whitelisted extensions/MIME types (`.png`, `.jpg`,
  `.jpeg`, `.gif`, `.svg`, `.webp`) and are size-capped.

---

## 7. Password handling

* Hashing: **bcrypt**, `BCRYPT_ROUNDS = 12` (12 ≈ 250 ms on modern hardware).
* Strength rule (admin-issued change): ≥ 8 chars, mixed case, digit, symbol,
  no 3+ consecutive repeating characters, no common-password match.
* Self-service flow:
  `POST /auth/forgot-password` → email OTP → `POST /auth/verify-reset-code`
  → `POST /auth/reset-password`. OTP is 6 digits, 10-minute expiry, single use.
* Auth burst limiter caps both login and reset to 20 attempts per 15 minutes
  per IP — sufficient to mitigate online brute-force.

> **Roadmap:** account-lockout after N failed logins is not yet implemented.
> Until it is, monitor `user_activity` for repeated `Login` rows from the
> same `user_id` against varying emails.

---

## 8. Audit trail

| What | Where |
|---|---|
| Login / logout, case create/update/confirm/cancel, sale create | `user_activity` table — surfaced in `/api/activity-log` (admin only). |
| Payment status changes (admin) | `user_activity`: `payment_status:{saleId}:{from}->{to}` or `payment_reverse:{saleId}:{n}/2`. Paid→Unpaid limited to **2** via `sales.payment_reverse_count`. |
| Policy soft-delete (admin JWT) | `sales.deleted_at` / `deletion_reason` / `deleted_by_user_id` + `user_activity` `policy_soft_delete:{saleId}:{reason}`. Endpoints: `POST /sales/{id}/soft-delete`, `GET /sales/meta/deletion-reasons`. |
| Agency / partner reassignment (admin JWT) | `agency_supervision_history` (period, supervisor, changed_by, reason, timestamps) + `user_activity` entry `agency_reassign:{agencyId}->{supervisorId}`. Endpoints: `PATCH /admin/agents/{id}/supervisor`, `GET /admin/agents/{id}/supervision-history`. |
| Supervisor / agency login email (admin JWT) | `users.email` unique (DB unique key + case-insensitive check). `PATCH /admin/agents/{id}` with `email` is **admin only**. Collisions return `409 email_taken`. Pre-check: `GET /admin/email-available?email=&excludeUserId=`. Not available via API key. |
| Contractual documents (Terms & Conditions) | Table `contractual_documents` (`full` / `brief` slots). Any JWT may list/download. **Admin JWT only** for upload, replace, metadata update, delete (`POST`/`PATCH`/`DELETE /contractual-documents/{key}`). Files under `uploads/contractual-docs/`. Not available via API key. |
| Every API-key request | `api_key_usage` table — `method`, `path`, `status_code`, `ip`, `user_agent`, `elapsed_ms`. **No request/response bodies are logged.** |
| API-key lifecycle (create, rotate, revoke) | Implicit in `api_keys.created_at` / `revoked_at`. |

The "no body logging" choice is deliberate to avoid storing PII (traveller
passport numbers, contact info) in a second place beyond the operational
tables.

---

## 9. Key lifecycle

* **Issuance** — admin POSTs to `/api/admin/api-keys`. Secret returned exactly
  once; only the prefix + hash persisted.
* **Rotation** — admin POSTs to `/api/admin/api-keys/:id/rotate`. Old key is
  revoked atomically, new secret returned once. Use this on suspected leak
  or for scheduled rotation (recommend every 90 days).
* **Revocation** — `DELETE /api/admin/api-keys/:id`. Subsequent requests with
  that secret are rejected with `revoked_api_key`.
* **Expiry** — set `expires_at` at creation time; requests after that
  timestamp are rejected with `expired_api_key`.
* **Visibility cascade** — disabling the owner user (`status = inactive`)
  immediately disables every API key they own.

### Recommended client-side practice

1. Store the secret in a managed secret store. Never commit it to git.
2. Limit egress IPs to the ones on the key's allowlist.
3. Rotate keys at least every 90 days, immediately on staff offboarding or
   suspected leak.
4. Use separate keys per environment (dev / staging / prod).
5. Use the **least-privilege** scopes (don't grant `cases:write` to a
   reporting integration).

---

## 10. PII & data residency

* Travellers' passport / ID numbers and contact details are stored at rest in
  MySQL on the hosting provider. They are returned in responses only to
  authenticated callers with visibility into the relevant case.
* PDF documents (invoices, certificates) are generated on demand — they are
  **not** persisted to disk and contain only the data already returned by the
  JSON endpoints.
* Uploaded partner logos are served at `/uploads/plan-logos/*` and are
  intentionally public (they appear on customer-facing certificates).

---

**WhatsApp transcripts.** `whatsapp_messages` stores what customers wrote and
what we replied, which includes names, dates of birth, passport numbers and email
addresses. Retention is bounded by a superadmin setting (180 days by default) and
enforced by `POST /api/whatsapp/maintenance/prune`, which is the only operation in
the module that deletes anything and never touches a session, case, traveller or
sale. Reading a transcript requires the separate `whatsapp:read` scope rather than
riding along with `cases:read`.

## 11. Endpoints that intentionally have no auth

| Endpoint | Why |
|---|---|
| `GET /` | Health check. |
| `GET /api/sales/certificate/public/:token` | Public certificate page served from the QR code on the printed certificate. The `token` is unique per certificate and acts as the capability. |
| `GET /uploads/plan-logos/*` | Static partner logos. |
| `GET /api/docs`, `GET /api/openapi.json`, `GET /api/openapi.yaml` | Public API documentation. |

Every other endpoint requires either a JWT or an API key.

---

## 11b. The WhatsApp webhook — signature authentication

`POST /api/whatsapp/webhook` is the one endpoint that accepts unauthenticated
requests in the bearer-token sense. It is authenticated differently:

- Meta signs each delivery with `X-Hub-Signature-256`: HMAC-SHA256 of the **raw**
  request body, keyed with the Meta app secret.
- The signature is verified before anything else happens, and compared in
  constant time. A fast-exit comparison would leak how much of a forged signature
  was correct.
- **The route is mounted before `express.json()` and before the input-sanitisation
  middleware, on purpose.** The signature covers the exact bytes Meta sent; once a
  body has been parsed, rewritten and re-serialised, no signature can ever verify
  again. This is the single most common way a WhatsApp integration ends up either
  broken or silently unauthenticated.
- Verification fails closed. With no app secret configured, nothing verifies.

Responses are deliberately asymmetric:

| Outcome | Status | Why |
|---|---|---|
| Signature missing or invalid | `403` | The request did not come from Meta. |
| Anything else, including our own failures | `200` | A non-2xx answer makes Meta retry with growing delay and eventually disable the webhook. A database outage must not cost the integration. |

Flood protection is applied **per phone number**, not per IP: every delivery
arrives from a handful of Meta addresses, so an IP-keyed limit would either never
trigger or throttle every customer at once.

Replay and ordering are handled at the data layer — messages are deduplicated on
Meta's `wa_message_id`, and concurrent messages from one number are serialised
with an advisory lock, so a customer sending three messages in two seconds cannot
advance the conversation three times.

---

## 11c. Stored credentials

WhatsApp credentials (access token, app secret, webhook verify token) are stored
AES-256-GCM encrypted in `app_settings`. GCM rather than CBC because it
authenticates the ciphertext: a tampered row fails to decrypt instead of quietly
yielding garbage we would then send to Meta.

- The master key lives only in `SETTINGS_ENCRYPTION_KEY`, never in the database.
  Encrypting at rest with the key stored beside the data would be theatre.
- Secrets are **write-only** over the API: reads return `••••••••wxyz`. The one
  exception is the webhook verify token, which the operator must copy into Meta —
  revealing it is a separate, audited request rather than something that rides
  along with every page load.
- Writing a secret with no master key configured is refused (`503
  encryption_unavailable`) rather than silently stored in clear.
- A value encrypted under a different key is reported as a decryption error and
  must be re-entered; it is never treated as valid.
- `/api/admin/whatsapp-settings*` is admin-JWT only and has **no API-key scope**.
  No 3rd-party key, however broad, can read or rewrite these credentials.
- Every change, connection test and token reveal is written to the activity log —
  which keys changed, never their values.

---

## 12. Disclosure & contact

Found a vulnerability? Email
[security@assurassistancepro.org](mailto:security@assurassistancepro.org) with
a description, repro steps, and the affected version. We aim to acknowledge
within 2 business days.

Please do not file public GitHub issues, social-media posts, or
non-coordinated disclosures for security issues.

---

## 13. Roadmap

* **Idempotency-Key** header for `POST /cases` and `POST /sales`.
* **Webhook delivery** (`sale.confirmed`, `payment.received`) with HMAC
  signatures.
* **OAuth 2.0 client-credentials** flow as an alternative to static API keys
  for partners with their own identity systems.
* **Account-lockout** after N failed logins, with admin override.
* **Per-route scope catalogue** validated at boot so new endpoints can't ship
  with an undeclared scope.
