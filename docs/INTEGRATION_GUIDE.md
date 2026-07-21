# AssurAssistance API — Integration Guide

This is the practical guide for building against the AssurAssistance backend
from a 3rd-party application. If you only want a flat reference of every
endpoint, see [`API.md`](./API.md). For the security model, see
[`SECURITY.md`](./SECURITY.md). For an interactive playground, browse
[`/api/docs`](https://backend-api.assurassistancepro.org/api/docs) (Swagger UI).

> **Audience:** developers at partner travel agencies, insurers, or internal
> AssurAssistance tooling teams who need programmatic access.

---

## 1. What you can do

- List the travel-insurance plans available in your country/route.
- Register travellers and create cases.
- Confirm a case as a sale (the system issues a policy number, a certificate
  number, an invoice number, and queues the PDFs).
- Download the invoice and the certificate PDFs.
- Mark invoices as paid.
- Pull the sales ledger and the "invoices by region" report.

Everything the AssurAssistance web app can do, your integration can do —
within the **scopes** your API key was issued with.

---

## 2. Getting an API key

API keys are minted by an AssurAssistance administrator. To request one,
email [support@assurassistancepro.org](mailto:support@assurassistancepro.org)
with:

1. The name of your application or workflow (e.g. `"Acme Travel — booking site"`).
2. The user/agency that should "own" the key — the key inherits that user's
   visibility (an agent's key only sees the agent's cases; an admin's key
   sees everything).
3. The scopes you need (see the [scope catalogue](#scopes)).
4. Optional: the IPs your servers will call from (we'll lock the key to that
   allowlist), and a custom requests-per-minute ceiling.

You'll receive a key that looks like:

```
aas_live_4f9aB5kT3mP8s9eD2gQ1cZ_8r0L7y2x6V_aBc1
```

Treat it like a password. Store it in your secret manager (1Password, AWS
Secrets Manager, etc.). It will never be shown again.

> If you lose the secret, ask the admin to **rotate** the key. That issues a
> fresh secret and revokes the old one.

---

## 3. Your first request

Every authenticated call carries the key in the `Authorization` header:

```bash
curl https://backend-api.assurassistancepro.org/api/catalogue \
  -H "Authorization: Bearer aas_live_4f9aB5kT3mP8s9eD2gQ1cZ..."
```

You should see:

```json
{
  "success": true,
  "data": [
    {
      "id": 12,
      "product_type": "Travel",
      "name": "AGICO Worldwide 30 Days",
      "currency": "XOF",
      "flat_price": 25000,
      "country_of_residence": "Burundi",
      "route_type": "Outbound",
      "theme_color": "#1E4D8B",
      "extra_id_fields": false,
      "status": "active"
    }
  ]
}
```

Three things to notice:

1. **Response envelope** — public endpoints return
   `{ success, data, meta?, error? }`. Legacy endpoints may return a bare
   array; we'll standardise these over time.
2. **Rate-limit headers** — every API-key response includes
   `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
3. **Visibility** — the catalogue is scoped to whatever your owner user is
   allowed to see.

---

## 4. Authentication

| Audience | Scheme | Header |
|---|---|---|
| 3rd-party server-to-server | **API key** | `Authorization: Bearer aas_live_…` |
| AssurAssistance web app | JWT (from `POST /auth/login`) | `Authorization: Bearer eyJhbGciOi…` |

The backend auto-detects which one you sent. **Always use API keys for server
integrations.** Never put a JWT into a 3rd-party app — JWTs are tied to a
human user session and rotate every 24h.

### Scopes

A scope is a string of the form `<resource>:<action>`. A key is issued with a
**subset** of these; every request is checked against the scope required by
the endpoint.

| Scope | Grants |
|---|---|
| `catalogue:read` | `GET /catalogue` |
| `cases:read` | `GET /cases`, `GET /cases/{id}`, `GET /cases/{id}/policy-edit-meta`, `GET /cases/all`, `GET /cases/my-cases`, `GET /cases/pending-sales` |
| `cases:write` | `POST /cases`, `POST /cases/group`, `PUT /cases/{id}/update`, `POST /cases/{id}/cancel`, `PATCH /cases/{id}/status` |
| `sales:read` | `GET /sales`, `GET /sales/{id}`, `GET /sales/invoice/{id}`, `GET /sales/certificate/{id}`, `GET /sales/certificate/{id}/page`, group ZIPs |
| `sales:write` | `POST /sales`, `POST /cases/{id}/confirm-sale` |
| `sales:payment` | `PATCH /sales/{id}/payment` |
| `ledger:read` | `GET /ledger`, `GET /ledger/export` |
| `invoices:read` | `GET /invoice-ledger`, `GET /invoice-ledger/export` |
| `agents:read` | (reserved) |
| `agents:write` | (reserved) |

If you call an endpoint without the right scope you'll get:

```json
{
  "success": false,
  "error": {
    "code": "insufficient_scope",
    "message": "Missing required scope: cases:write",
    "requiredScope": "cases:write",
    "availableScopes": ["catalogue:read", "cases:read"]
  }
}
```

---

## 5. Core workflow — selling a policy

Selling a travel-insurance policy is a **3-step** flow.

### Step 1 — Pick a plan

```bash
curl https://backend-api.assurassistancepro.org/api/catalogue \
  -H "Authorization: Bearer $AAS_KEY" \
  | jq '.data[] | {id, name, flat_price, currency, country_of_residence}'
```

Pick the `id` of the plan you want to sell.

### Step 2 — Create the case

```bash
curl -X POST https://backend-api.assurassistancepro.org/api/cases \
  -H "Authorization: Bearer $AAS_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "traveller": {
      "first_name": "Aïcha",
      "last_name": "Diallo",
      "date_of_birth": "1992-03-14",
      "country_of_residence": "Ivory Coast",
      "gender": "Female",
      "nationality": "Ivorian",
      "passport_or_id": "CI0123456",
      "phone": "+225 07 12 34 56 78",
      "email": "aicha@example.com"
    },
    "caseData": {
      "destination": "France, Spain",
      "start_date": "2026-06-01",
      "end_date": "2026-06-15",
      "selected_plan_id": 12
    }
  }'
```

You get back:

```json
{ "message": "Case created", "caseId": 4821 }
```

### Step 2b — Compute the premium correctly

Stay length is inclusive (`end − start + 1`). Map it to the smallest catalogue
tier that covers the stay (default **10 / 45 / 93 / 180 / 365** days). Then apply
age:

| Age | Premium factor |
|-----|----------------|
| Under 16 | × 0.5 |
| 16 – 75 | × 1 |
| 76 – 80 | × 2 |
| 81 – 85 | × 4 |
| Over 85 | reject — customer must request a specific exemption |

Do **not** add guarantee/coverage limit amounts into the billable total.
`guarantees_total` is always stored as `0`.

Example: 26-day stay, traveller under 16 → 45-day tier 30 500 × 0.5 = **15 250**.

### Step 3 — Confirm the sale

```bash
curl -X POST https://backend-api.assurassistancepro.org/api/cases/4821/confirm-sale \
  -H "Authorization: Bearer $AAS_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "premium_amount": 15250, "tax": 0, "total": 15250 }'
```

Response:

```json
{
  "message": "Sale confirmed",
  "saleId": 7912,
  "policyNumber": "AAS-2026-007912",
  "certificateNumber": "CERT-2026-007912"
}
```

The system has now:

- Stored the sale, invoice, and certificate metadata.
- Made the invoice + certificate PDFs available on demand.
- Generated a public certificate URL with a unique token (used by the QR code on the printed certificate).

### Step 3b — Editing a confirmed policy

`PUT /cases/{id}/update` (scope `cases:write`) updates traveller/case fields.
**When a sale already exists, the API recalculates `plan_price` / `premium_amount` /
`total` from the new dates and date of birth** and syncs the linked invoice.

Agency/operator keys: only first/last name, destination, and travel dates; at most
3 edits; only while more than 24 hours before departure (`start_date`). Check
`GET /cases/{id}/policy-edit-meta` first.

The update response includes a `pricing` object — always replace any locally
cached premium with those values.

### Step 4 — Hand the documents to your customer

```bash
# Invoice (PDF binary):
curl -fOJ "https://backend-api.assurassistancepro.org/api/sales/invoice/7912" \
  -H "Authorization: Bearer $AAS_KEY"

# Certificate (PDF binary):
curl -fOJ "https://backend-api.assurassistancepro.org/api/sales/certificate/7912" \
  -H "Authorization: Bearer $AAS_KEY"
```

Both download as `application/pdf` with `Content-Disposition: attachment;
filename="…"`. Stream them straight to your customer or store them in your
own document vault.

### Step 5 — Mark as paid (optional)

When you receive payment:

```bash
curl -X PATCH https://backend-api.assurassistancepro.org/api/sales/7912/payment \
  -H "Authorization: Bearer $AAS_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "payment_status": "Paid", "received_amount": 15250, "payment_notes": "Wire transfer ABC" }'
```

---

## 6. Group subscriptions

Sell one plan to many travellers at once (a family, a tour group):

```bash
curl -X POST https://backend-api.assurassistancepro.org/api/cases/group \
  -H "Authorization: Bearer $AAS_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "travellers": [
      { "first_name": "Jean",   "last_name": "Kouassi", "date_of_birth": "1985-01-15", "country_of_residence": "Ivory Coast", "gender": "Male", "nationality": "Ivorian", "passport_or_id": "CI001", "phone": "+225..." },
      { "first_name": "Marie",  "last_name": "Kouassi", "date_of_birth": "1987-09-02", "country_of_residence": "Ivory Coast", "gender": "Female", "nationality": "Ivorian", "passport_or_id": "CI002", "phone": "+225..." }
    ],
    "caseData": {
      "destination": "France",
      "start_date": "2026-07-01",
      "end_date": "2026-07-21",
      "selected_plan_id": 12
    }
  }'
```

Response:

```json
{
  "message": "Group created",
  "groupId": "grp_8f0c1a…",
  "caseIds": [4822, 4823]
}
```

Each case can be confirmed individually with `/cases/{id}/confirm-sale`, or
you can download every invoice/certificate in one go:

```bash
curl -fOJ "https://backend-api.assurassistancepro.org/api/sales/group/grp_8f0c1a…/invoices-zip"   -H "Authorization: Bearer $AAS_KEY"
curl -fOJ "https://backend-api.assurassistancepro.org/api/sales/group/grp_8f0c1a…/certificates-zip" -H "Authorization: Bearer $AAS_KEY"
```

---

## 7. Reporting

### Sales ledger

```bash
curl "https://backend-api.assurassistancepro.org/api/ledger?startDate=2026-01-01&endDate=2026-06-30&page=1&limit=50" \
  -H "Authorization: Bearer $AAS_KEY"
```

Response shape (truncated):

```json
{
  "success": true,
  "data": [ { "sale_id": 7912, "traveller_name": "Aïcha Diallo", "plan_name": "AGICO Worldwide 30 Days", "total": 25000, "payment_status": "Paid", "confirmed_at": "2026-05-20T14:31:00.000Z" } ],
  "meta": { "total": 318, "page": 1, "limit": 50 }
}
```

CSV export:

```
GET /ledger/export?startDate=…&endDate=…
```

### Invoices by region

```bash
curl "https://backend-api.assurassistancepro.org/api/invoice-ledger?regionBy=residence&startDate=2026-01-01" \
  -H "Authorization: Bearer $AAS_KEY"
```

Returns both the paginated rows and a `regionSummary` array you can use to
build a dashboard:

```json
{
  "success": true,
  "data": [ /* invoice rows */ ],
  "meta": { "total": 318, "page": 1, "limit": 25, "regionBy": "residence" },
  "regionSummary": [
    { "region": "Ivory Coast", "invoice_count": 142, "total_amount": 3550000, "paid_amount": 3100000, "unpaid_amount": 450000 },
    { "region": "Burundi",     "invoice_count": 87,  "total_amount": 2175000, "paid_amount": 1900000, "unpaid_amount": 275000 }
  ]
}
```

`regionBy` accepts: `residence` (traveller's country of residence, default),
`destination` (travel corridor), or `agent` (selling agent's country).

---

## 8. Conventions

### Pagination

Paginated endpoints accept `page` (1-indexed) and `limit` (max 200). They
return:

```json
{
  "success": true,
  "data": [ /* rows */ ],
  "meta": { "total": 1234, "page": 1, "limit": 25 }
}
```

To page forward, increment `page` until `data.length === 0` or
`page * limit >= meta.total`.

### Dates

- **Inputs** — accept `YYYY-MM-DD` for dates, ISO-8601 (`2026-05-20T14:31:00Z`) for timestamps.
- **Outputs** — timestamps are returned as ISO-8601 UTC.

### Currency

The system stores monetary values as `DECIMAL(15,2)` in the plan's currency
(default `XOF`). Treat amounts as numbers — don't assume cents or rounding.

### Idempotency

`POST /cases` and `POST /cases/group` are **not currently idempotent**.
If your network call fails mid-flight, query `GET /cases?search=<passport>`
to check whether the case was created before retrying. (Idempotency keys are
on the roadmap.)

---

## 9. Errors

Public-API endpoints return:

```json
{
  "success": false,
  "error": {
    "code": "invalid_api_key",
    "message": "API key not recognised"
  }
}
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `validation_error` | Body or query violates the schema. |
| 401 | `missing_token` | No `Authorization` header. |
| 401 | `invalid_api_key` / `revoked_api_key` / `expired_api_key` / `invalid_token` | Bad credential. |
| 403 | `insufficient_scope` | Key lacks the required scope. |
| 403 | `ip_not_allowed` | Request IP not on the key's allowlist. |
| 404 | `not_found` | Resource doesn't exist or is outside your visibility. |
| 429 | `rate_limited` | Too many requests (see `X-RateLimit-*` headers). |
| 500 | `server_error` | Something went wrong on our side. Retry with exponential backoff. |

> **Note:** A handful of older endpoints (auth, some case routes) still
> return `{ "message": "…" }` only. We are migrating them all to the unified
> envelope above; you can rely on HTTP status codes either way.

---

## 10. Rate limiting

Two rate limits apply.

1. **Per-IP global limit** — 600 requests / 15 min by default. Tuned via
   `RATE_LIMIT_*` env vars.
2. **Per-key sliding window** — 120 requests / minute by default, overridable
   per key via the `rate_limit_per_min` field on the key.

When you hit either limit you get HTTP `429`:

```json
{
  "success": false,
  "error": {
    "code": "rate_limited",
    "message": "Rate limit exceeded (120/min). Retry in 32s."
  }
}
```

**Always honour `X-RateLimit-Reset`** — it's the number of seconds until the
window resets. A simple back-off:

```js
if (res.status === 429) {
  const wait = Number(res.headers.get('X-RateLimit-Reset') || '5') * 1000;
  await new Promise(r => setTimeout(r, wait));
  // retry
}
```

---

## 11. Reference clients

### Node.js (axios)

```js
import axios from 'axios';

export const aas = axios.create({
  baseURL: 'https://backend-api.assurassistancepro.org/api',
  headers: { Authorization: `Bearer ${process.env.AAS_KEY}` },
  timeout: 30_000
});

// Example: list plans
const { data } = await aas.get('/catalogue');
console.log(data.data);

// Example: create and confirm a sale
const create = await aas.post('/cases', { traveller, caseData });
const sale   = await aas.post(`/cases/${create.data.caseId}/confirm-sale`, {
  premium_amount: 25000, tax: 0, total: 25000
});
const pdf    = await aas.get(`/sales/invoice/${sale.data.saleId}`, {
  responseType: 'arraybuffer'
});
fs.writeFileSync(`invoice-${sale.data.saleId}.pdf`, pdf.data);
```

### Python (requests)

```python
import os, requests

AAS = "https://backend-api.assurassistancepro.org/api"
H = {"Authorization": f"Bearer {os.environ['AAS_KEY']}"}

plans = requests.get(f"{AAS}/catalogue", headers=H).json()["data"]

case = requests.post(f"{AAS}/cases", headers=H, json={
    "traveller": { ... },
    "caseData": { ... }
}).json()

sale = requests.post(f"{AAS}/cases/{case['caseId']}/confirm-sale", headers=H, json={
    "premium_amount": 25000, "tax": 0, "total": 25000
}).json()

pdf = requests.get(f"{AAS}/sales/invoice/{sale['saleId']}", headers=H)
open(f"invoice-{sale['saleId']}.pdf", "wb").write(pdf.content)
```

### cURL — Postman collection

A ready-to-import Postman collection lives at
[`docs/postman_collection.json`](./postman_collection.json). It defines a
`{{baseUrl}}` and `{{apiKey}}` variable so you can flip between staging and
production cleanly.

---

## 12. Sandbox & versioning

- **Sandbox:** request an `aas_test_*` key for the staging environment
  (`https://backend.staging.acareeracademy.com/api`). Test keys can be wiped
  at any time and do not generate real PDFs.
- **Versioning:** the API is `v1` (implicit in the path). Breaking changes
  will land on a `/v2` prefix; non-breaking additions (new fields, new
  endpoints) are made in place.
- **Deprecation:** removed fields are announced at least 90 days before being
  retired.

---

## 13. Support

- **Email:** [support@assurassistancepro.org](mailto:support@assurassistancepro.org)
- **Swagger UI:** [https://backend-api.assurassistancepro.org/api/docs](https://backend-api.assurassistancepro.org/api/docs)
- **Status:** [TBD]

Please include your key prefix (e.g. `aas_live_4f9a…`) and a request ID (if
present in error responses) when reporting issues. **Never send the full
secret.**
