# AssurAssistance API Reference

Flat reference of every backend endpoint. For a tutorial start with the
[Integration Guide](./INTEGRATION_GUIDE.md). For the machine-readable spec
see [`openapi.yaml`](./openapi.yaml) (also served at `/api/openapi.json`
and rendered as Swagger UI at `/api/docs`).

- **Base URL:** `https://backend-api.assurassistancepro.org/api`
- **Local:** `http://localhost:3000/api`
- **Auth:** `Authorization: Bearer <jwt|api-key>` (see [SECURITY.md](./SECURITY.md))

Legend:

- **Auth?** — JWT = web-app JWT, KEY = API key, ADMIN = JWT+admin role, SUB = JWT+admin/sub-admin, PUBLIC = no auth.
- **Scope** — required when called with an API key.

---

## 1. Authentication — `/api/auth`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/login` | PUBLIC | Exchange email + password for a JWT. |
| POST | `/auth/logout` | JWT | Invalidate the current session (server-side activity log). |
| POST | `/auth/change-password` | JWT | Logged-in password change. |
| POST | `/auth/forgot-password` | PUBLIC | Send an OTP email. |
| POST | `/auth/verify-reset-code` | PUBLIC | Verify the OTP. |
| POST | `/auth/reset-password` | PUBLIC | Set a new password using the OTP. |

### POST /auth/login

**Request**

```json
{ "email": "agent@example.com", "password": "•••••••••" }
```

**Response (200)**

```json
{
  "token": "eyJhbGciOiJI…",
  "user": {
    "id": 42,
    "name": "Aïcha Diallo",
    "email": "agent@example.com",
    "role": "agent",
    "force_password_change": false
  }
}
```

Errors: `400` (missing fields), `401` (bad credentials / revoked account).

---

## 2. Catalogue — `/api/catalogue`

| Method | Path | Auth | Scope | Description |
|---|---|---|---|---|
| GET    | `/catalogue` | JWT or KEY | `catalogue:read` | List plans. |
| POST   | `/catalogue` | ADMIN | — | Create a new plan. |
| PUT    | `/catalogue/:id` | ADMIN | — | Update a plan. |
| DELETE | `/catalogue/:id` | ADMIN | — | Delete a plan. |
| POST   | `/catalogue/:id/partner-logo` | ADMIN | — | Upload partner logo (multipart, field `partner_logo`, ≤2 MB). |
| DELETE | `/catalogue/:id/partner-logo` | ADMIN | — | Remove partner logo. |

### GET /catalogue — sample response

```json
{
  "success": true,
  "data": [
    {
      "id": 12,
      "product_type": "Travel",
      "name": "AGICO Worldwide 30 Days",
      "coverage": "Medical: €60,000 · …",
      "eligible_destinations": "Schengen, UK, USA, Canada",
      "durations": "30",
      "pricing_rules": null,
      "flat_price": 25000,
      "country_of_residence": "Burundi",
      "route_type": "Outbound",
      "currency": "XOF",
      "theme_color": "#1E4D8B",
      "extra_id_fields": false,
      "partner_insurer_logo": "/uploads/plan-logos/agico.png",
      "status": "active"
    }
  ]
}
```

---

## 3. Cases — `/api/cases`

| Method | Path | Auth | Scope | Description |
|---|---|---|---|---|
| GET    | `/cases` | JWT or KEY | `cases:read` | Cases visible to the caller. |
| POST   | `/cases` | JWT or KEY | `cases:write` | Create a case (one traveller). |
| POST   | `/cases/group` | JWT or KEY | `cases:write` | Create a group case (many travellers, one trip). |
| GET    | `/cases/all` | JWT or KEY | `cases:read` | Paginated list (admin/sub_admin see broader set). |
| GET    | `/cases/my-cases` | JWT or KEY | `cases:read` | Caller's cases, paginated. |
| GET    | `/cases/pending-sales` | JWT or KEY | `cases:read` | Cases not yet confirmed as sales. |
| GET    | `/cases/:caseId` | JWT or KEY | `cases:read` | Single case + traveller + plan + sale. |
| PUT    | `/cases/:caseId/update` | JWT or KEY | `cases:write` | Update case + traveller (limits apply for agents). |
| POST   | `/cases/:caseId/cancel` | JWT or KEY | `cases:write` | Cancel a case. |
| PATCH  | `/cases/:caseId/status` | JWT or KEY | `cases:write` | Change status. |
| POST   | `/cases/:caseId/confirm-sale` | JWT or KEY | `sales:write` | Confirm sale (issues policy/cert numbers). |
| GET    | `/cases/:caseId/policy-edit-meta` | JWT or KEY | `cases:read` | Remaining edits + lock reason. |

### POST /cases — request

```json
{
  "traveller": {
    "first_name": "Aïcha",
    "last_name":  "Diallo",
    "date_of_birth": "1992-03-14",
    "country_of_residence": "Ivory Coast",
    "gender": "Female",
    "nationality": "Ivorian",
    "passport_or_id": "CI0123456",
    "phone": "+225 07 12 34 56 78",
    "email": "aicha@example.com",
    "address": "Cocody, Abidjan"
  },
  "caseData": {
    "destination": "France, Spain",
    "start_date": "2026-06-01",
    "end_date":   "2026-06-15",
    "selected_plan_id": 12
  }
}
```

**201 Created**

```json
{ "message": "Case created", "caseId": 4821 }
```

### POST /cases/group — request

Same body shape as `/cases`, but `travellers` is an array:

```json
{
  "travellers": [ { "first_name": "...", "last_name": "...", "date_of_birth": "...", "passport_or_id": "...", ... } ],
  "caseData":   { "destination": "...", "start_date": "...", "end_date": "...", "selected_plan_id": 12 }
}
```

**201 Created**

```json
{ "message": "Group created", "groupId": "grp_8f0c1a…", "caseIds": [4822, 4823] }
```

### GET /cases/:caseId/policy-edit-meta — response

```json
{
  "success": true,
  "data": {
    "hasSale": true,
    "policyEditCount": 1,
    "maxEdits": 3,
    "editsRemaining": 2,
    "lockReason": null,
    "travelStartsAt": "2026-06-01T00:00:00.000Z",
    "hoursToTravel": 720
  }
}
```

`lockReason` is one of `too_close_to_travel`, `max_edits_reached`, `no_sale`, or `null`.

---

## 4. Sales — `/api/sales`

| Method | Path | Auth | Scope | Description |
|---|---|---|---|---|
| POST   | `/sales` | JWT or KEY | `sales:write` | Create a sale from a confirmed case. |
| GET    | `/sales` | JWT or KEY | `sales:read`  | List sales. |
| GET    | `/sales/:id` | JWT or KEY | `sales:read`  | Single sale. |
| PATCH  | `/sales/:id/payment` | JWT or KEY | `sales:payment` | Update payment status. |

### POST /sales — request

```json
{
  "case_id": 4821,
  "premium_amount": 25000,
  "tax": 0,
  "total": 25000,
  "currency": "XOF",
  "plan_price": 25000,
  "guarantees_total": 0,
  "guarantees_details": null
}
```

**201 Created**

```json
{
  "message": "Sale created",
  "saleId": 7912,
  "policyNumber": "AAS-2026-007912",
  "certificateNumber": "CERT-2026-007912"
}
```

### PATCH /sales/:id/payment

```json
{ "payment_status": "Paid", "received_amount": 25000, "payment_notes": "Wire transfer ABC" }
```

`payment_status` ∈ `Paid | Unpaid | Partial`. Only the `sales:payment` scope (or an admin JWT) may call this.

---

## 5. Documents — `/api/sales/certificate/*`, `/api/sales/invoice/*`

| Method | Path | Auth | Scope | Returns |
|---|---|---|---|---|
| GET | `/sales/invoice/:id` | JWT or KEY | `sales:read` | `application/pdf` (invoice). |
| GET | `/sales/certificate/:id` | JWT or KEY | `sales:read` | `application/pdf` (certificate). |
| GET | `/sales/certificate/:id/page` | JWT or KEY | `sales:read` | JSON payload used to render the certificate. |
| GET | `/sales/certificate/public/:token` | PUBLIC | — | Same JSON, served via the QR token. |
| GET | `/sales/group/:groupId/invoices-zip` | JWT or KEY | `sales:read` | `application/zip` (all invoices in the group). |
| GET | `/sales/group/:groupId/certificates-zip` | JWT or KEY | `sales:read` | `application/zip` (all certificates in the group). |

The PDFs are generated on demand. Headers include `Content-Disposition:
attachment; filename="…"`. Stream the body or persist to disk on your side.

---

## 6. Reports — `/api/ledger`, `/api/invoice-ledger`

### GET /ledger

Query: `page`, `limit`, `search`, `startDate` (YYYY-MM-DD), `endDate`,
`paymentStatus` (`Paid|Unpaid|Partial`), `status` (case status).

**Response**

```json
{
  "success": true,
  "data": [
    {
      "sale_id": 7912,
      "case_id": 4821,
      "agent_id": 42,
      "created_by_name": "Aïcha Diallo",
      "traveller_name": "Aïcha Diallo",
      "traveller_phone": "+225...",
      "plan_name": "AGICO Worldwide 30 Days",
      "product_type": "Travel",
      "policy_number": "AAS-2026-007912",
      "certificate_number": "CERT-2026-007912",
      "plan_price": 25000,
      "premium_amount": 25000,
      "tax": 0,
      "total": 25000,
      "received_amount": 25000,
      "payment_status": "Paid",
      "confirmed_at": "2026-05-20T14:31:00.000Z"
    }
  ],
  "meta": { "total": 318, "page": 1, "limit": 25 }
}
```

### GET /ledger/export

Same filters; returns `text/csv` with a UTF-8 BOM (Excel-friendly). Filename:
`sales_ledger_<timestamp>.csv`.

### GET /invoice-ledger

Like `/ledger`, but anchored on invoices and grouped by region. Extra query
params:

| Param | Values | Default |
|---|---|---|
| `region` | Any region value (country name or destination string). | — |
| `regionBy` | `residence` \| `destination` \| `agent` | `residence` |

**Response**

```json
{
  "success": true,
  "data": [ /* InvoiceLedgerRow array */ ],
  "meta": { "total": 318, "page": 1, "limit": 25, "regionBy": "residence" },
  "regionSummary": [
    { "region": "Ivory Coast", "invoice_count": 142, "total_amount": 3550000, "paid_amount": 3100000, "unpaid_amount": 450000 }
  ]
}
```

### GET /invoice-ledger/export

Same filters; CSV file with a column-rich row (region, traveller country,
destination, plan, agent, totals, payment status, etc.).

---

## 7. Agents / Users — `/api/admin`, `/api/users`

These endpoints are part of the staff/admin surface. They are reachable via
**JWT only** — there is no API-key scope that exposes them. (Reserved scopes
`agents:read` / `agents:write` exist for a future opening.)

### Admin (JWT, admin or sub-admin)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/admin/create-agent` | SUB | Create an agency account. Returns the temporary password. |
| GET | `/admin/list-agents` | SUB | Paginated list of agencies. |
| GET | `/admin/agents/:id` | SUB | One agency + its sub-agents. |
| PATCH | `/admin/agents/:id` | SUB | Update profile fields. |
| DELETE | `/admin/agents/:id` | SUB | Remove an agency (and optionally its hierarchy). |
| GET | `/admin/agents/:id/sub-agents` | SUB | Sub-agents under an agency. |
| POST | `/admin/agents/:id/sub-agents` | SUB | Create a sub-agent. |
| PATCH | `/admin/users/status` | SUB | Activate / deactivate a user. |
| POST | `/admin/send-reset-link` | SUB | Email a password-reset link to a user. |
| GET | `/admin/dashboard` | SUB | KPIs for the home page. |
| GET | `/admin/production-trend` | ADMIN | Monthly + yearly trend lines. |
| GET | `/admin/agent-hierarchy` | ADMIN | Tree of admin / sub-admin / agent ownership. |
| GET | `/admin/agent-hierarchy/export` | ADMIN | CSV export of the hierarchy. |
| GET | `/admin/profile` | JWT | Current user profile (admin variant). |
| PATCH | `/admin/profile` | JWT | Update own profile. |
| PATCH | `/admin/change-password` | JWT | Change own password. |
| POST | `/admin/create-sub-admin` | ADMIN | Create a sub-administrator. |
| GET | `/admin/sub-admins` | ADMIN | List sub-administrators. |
| DELETE | `/admin/sub-admins/:id` | ADMIN | Delete a sub-administrator. |

### User (JWT)

| Method | Path | Description |
|---|---|---|
| GET | `/users/me` | Profile of the current JWT user. |
| GET | `/users/dashboard` | KPIs scoped to the current user. |
| GET | `/users/profile` | Same as `/users/me` but admin-style payload. |
| PATCH | `/users/profile` | Update own profile. |
| PATCH | `/users/change-password` | Change own password. |

---

## 8. API Keys — `/api/admin/api-keys` (admin JWT only)

| Method | Path | Description |
|---|---|---|
| GET    | `/admin/api-keys/scopes` | Canonical list of available scopes. |
| GET    | `/admin/api-keys` | List keys (optional `?owner_user_id=…`). |
| POST   | `/admin/api-keys` | Mint a new key. **Secret returned once.** |
| GET    | `/admin/api-keys/:id` | Inspect a key + recent usage (last 100). |
| PATCH  | `/admin/api-keys/:id` | Update name / scopes / IP allowlist / rate limit / expiry. |
| POST   | `/admin/api-keys/:id/rotate` | Issue a new secret, revoke the old one. |
| DELETE | `/admin/api-keys/:id` | Revoke (no new requests accepted). |

### POST /admin/api-keys

**Request**

```json
{
  "name": "Acme Travel — production",
  "owner_user_id": 42,
  "scopes": ["catalogue:read", "cases:read", "cases:write", "sales:read", "sales:write"],
  "ip_allowlist": "185.10.20.30, 185.10.20.0/24",
  "rate_limit_per_min": 240,
  "expires_at": "2027-01-01T00:00:00Z"
}
```

**201 Created**

```json
{
  "success": true,
  "data": {
    "id": 9,
    "name": "Acme Travel — production",
    "key_prefix": "aas_live_4f9a",
    "scopes": ["catalogue:read", "cases:read", "cases:write", "sales:read", "sales:write"],
    "secret": "aas_live_4f9aB5kT3mP8s9eD2gQ1cZ_8r0L7y2x6V_aBc1",
    "ip_allowlist": "185.10.20.30,185.10.20.0/24",
    "rate_limit_per_min": 240,
    "expires_at": "2027-01-01T00:00:00.000Z"
  },
  "message": "API key created. Copy the secret now — it will not be shown again."
}
```

`secret` will be omitted on any subsequent GET; only `key_prefix` is shown.

---

## 9. Activity Log — `/api/activity-log` (admin JWT only)

| Method | Path | Description |
|---|---|---|
| GET | `/activity-log` | Paginated user-activity log (`page`, `limit`, `search`, `startDate`, `endDate`). |
| DELETE | `/activity-log/:id` | Delete a single entry. |

---

## 10. Reconciliation — `/api/reconciliation` (JWT)

| Method | Path | Description |
|---|---|---|
| GET | `/reconciliation` | Monthly reconciliation (`?month=Sep&year=2026`). |
| GET | `/reconciliation/export` | CSV (Excel-friendly). |

---

## 11. Partner invoices — `/api/partner-invoices` (admin / sub-admin JWT)

Periodic premium invoices per partner (travel agency, corporate desk, …). Sub-administrators only see the agencies under their supervision. Commissions are applied per coverage-duration tier (10/45/93/180/365 days) and deducted from the premium total; they appear only on these invoices, never on individual sales.

| Method | Path | Description |
|---|---|---|
| GET | `/partner-invoices/partners` | Partners the caller may invoice. |
| GET | `/partner-invoices/summary?startDate&endDate` | Period totals: premiums, collected, commissions, net to transfer. |
| GET | `/partner-invoices/:partnerId?startDate&endDate` | Invoice preview (JSON): per-sale lines with commissions + totals. |
| GET | `/partner-invoices/:partnerId/pdf?startDate&endDate&currency` | Invoice PDF in the official format (logos, addresses, premium breakdown). `Accept-Language: fr` for French labels. `currency` = `XOF` \| `USD` \| `EUR` (amounts convert from XOF base). |

---

## 12. Health & docs

| Method | Path | Description |
|---|---|---|
| GET | `/` | "Assur Assistance Backend is running" (plaintext). |
| GET | `/api/docs` | Swagger UI. |
| GET | `/api/openapi.json` | OpenAPI spec (JSON). |
| GET | `/api/openapi.yaml` | OpenAPI spec (YAML). |

---

## Appendix A — Standard error shapes

Newer endpoints (auth, API keys, public-API routes) use a unified envelope:

```json
{
  "success": false,
  "error": {
    "code": "<machine_readable_code>",
    "message": "<human readable explanation>"
  }
}
```

Some legacy endpoints still return:

```json
{ "message": "Server error" }
```

In either case the HTTP status code is authoritative.

### Common codes

| Status | `code` |
|---|---|
| 400 | `validation_error` |
| 401 | `missing_token`, `invalid_token`, `invalid_api_key`, `revoked_api_key`, `expired_api_key`, `owner_disabled` |
| 403 | `insufficient_scope`, `ip_not_allowed`, `Forbidden: admin only`, `Forbidden: admin or sub-administrator only` |
| 404 | `not_found` |
| 429 | `rate_limited`, `rate_limited_auth` |
| 500 | `server_error` |

---

## Appendix B — Curl snippets

```bash
# Authenticate as the web app
curl -X POST $AAS_BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"agent@example.com","password":"…"}'

# 3rd-party — list plans
curl $AAS_BASE/catalogue -H "Authorization: Bearer $AAS_KEY"

# Create a case
curl -X POST $AAS_BASE/cases -H "Authorization: Bearer $AAS_KEY" \
  -H 'Content-Type: application/json' \
  -d @case.json

# Confirm sale
curl -X POST $AAS_BASE/cases/4821/confirm-sale \
  -H "Authorization: Bearer $AAS_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"premium_amount":25000,"tax":0,"total":25000}'

# Download the invoice
curl -L -OJ $AAS_BASE/sales/invoice/7912 -H "Authorization: Bearer $AAS_KEY"

# Mark as paid
curl -X PATCH $AAS_BASE/sales/7912/payment \
  -H "Authorization: Bearer $AAS_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"payment_status":"Paid","received_amount":25000}'

# Pull the ledger
curl "$AAS_BASE/ledger?startDate=2026-01-01&endDate=2026-06-30&page=1&limit=50" \
  -H "Authorization: Bearer $AAS_KEY"
```
