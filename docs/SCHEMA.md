# Database schema

The tables, what each one is for, and the constraints that exist on purpose.
Generated from a database built the way a deployment builds one — `database_dump.sql`
followed by every file in `migrations/` in the order `scripts/migrate.js` applies them —
so what is written here is what a correctly migrated database actually contains.

MySQL 8 / MariaDB, `utf8mb4`. 24 tables and 1 view.

Types are printed as the server reports them. The reference build runs on MariaDB, which
reports a `JSON` column as `longtext` and a `BOOLEAN` as `tinyint(1)`; MySQL 8 prints
`json`. The migrations are the declaration — this is the description.

---

## How the schema is changed

Every change is an additive, re-runnable migration under `migrations/`, applied by
`npm run migrate`. The rules exist because these migrations run against a live database
that already holds policies people have bought:

* **Nothing is dropped or renamed.** A replaced column stays until a separate, deliberate
  cleanup, and a deprecated one is documented rather than removed.
* **Every DDL statement is guarded** by an `information_schema` check, so a file can be
  re-run and will do nothing the second time.
* **ENUM values are appended, never reordered**, because order is what is stored.
* **Seeds use `INSERT IGNORE`** so re-running cannot duplicate or overwrite.
* Managed migrations are named `m<milestone>_<nn>_<name>.sql` and are tracked in
  `schema_migrations` with a checksum; editing one after it has run is refused. Files
  without that prefix are legacy migrations that predate the ledger.

A migration that cannot be made safe stops and reports instead of forcing its way: `m3_03`
adds its UNIQUE index only when it finds no duplicates, and otherwise tells you how many
it found and leaves the data untouched.

---

## Conventions

* Money is `DECIMAL(15,2)`. Never a float.
* Currency is a 3-letter code per row, defaulting to `XOF`.
* `created_at` / `updated_at` are `TIMESTAMP` with database defaults.
* Deleting a policy is `deleted_at`, not a `DELETE`. Queries that mean "live policies"
  say `deleted_at IS NULL`.
* JSON is stored in `LONGTEXT`/`JSON` columns and always parsed defensively — a row
  written by an older version must not crash a reader.
* A generated column plus a UNIQUE index is how "only one live child per parent" is
  enforced (`sales.active_case_lock`, `whatsapp_sessions.active_lock`).

---

## People and access

### `users`

Every account that can sign in: `admin`, `sub_admin`, `insurer_supervisor` and
`agent`. Agencies are agents with `parent_agent_id IS NULL`; their sub-agents point at
them. `created_by_id` is who opened the account, which is what the supervision
hierarchy is derived from. `partner_insurer` binds an `insurer_supervisor` to one
insurer's plans and is NULL for everyone else.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `name` | `varchar(255)` | no |  |  |
| `email` | `varchar(255)` | no |  |  |
| `password` | `varchar(255)` | no |  |  |
| `role` | `enum('admin','sub_admin','insurer_supervisor','agent')` | no | `'agent'` |  |
| `status` | `enum('active','inactive')` | no | `'active'` |  |
| `force_password_change` | `tinyint(1)` | yes | `0` |  |
| `last_login` | `datetime` | yes |  |  |
| `created_at` | `timestamp` | yes | `current_timestamp()` |  |
| `updated_at` | `timestamp` | yes | `current_timestamp()` | set on update |
| `company_name` | `varchar(255)` | yes |  |  |
| `partnership_type` | `varchar(100)` | yes |  |  |
| `country_of_residence` | `varchar(255)` | yes |  |  |
| `iata_number` | `varchar(50)` | yes |  |  |
| `geographical_location` | `varchar(255)` | yes |  |  |
| `work_phone` | `varchar(50)` | yes |  |  |
| `whatsapp_phone` | `varchar(50)` | yes |  |  |
| `parent_agent_id` | `int(11)` | yes |  |  |
| `created_by_id` | `int(11)` | yes |  |  |
| `partner_insurer` | `varchar(64)` | yes |  | Insurer key for insurer_supervisor (e.g. gna, agico) |

**Primary key** `id`  
**Unique** `email` (email)  
**Indexes** `fk_parent_agent` (parent_agent_id), `fk_users_created_by` (created_by_id), `idx_users_partner_insurer` (partner_insurer)

**Foreign keys**

* `created_by_id` → `users.id` — on delete set null
* `parent_agent_id` → `users.id` — on delete set null

### `agency_supervision_history`

Who supervised which agency, and when. Reassigning a supervisor closes the open
period (`effective_to IS NULL`) and opens a new one, so commission for a past month
is still attributed to whoever was supervising then.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `agency_user_id` | `int(11)` | no |  | Top-level agency (role=agent, parent_agent_id NULL) |
| `supervisor_user_id` | `int(11)` | yes |  | Admin or sub_admin who supervised during this period |
| `effective_from` | `date` | no |  |  |
| `effective_to` | `date` | yes |  | NULL = current / ongoing period |
| `changed_by_user_id` | `int(11)` | no |  | Admin who performed the change |
| `reason` | `varchar(500)` | yes |  |  |
| `created_at` | `timestamp` | no | `current_timestamp()` |  |

**Primary key** `id`  
**Indexes** `fk_ash_changed_by` (changed_by_user_id), `idx_agency_from` (agency_user_id,effective_from), `idx_supervisor` (supervisor_user_id)

**Foreign keys**

* `agency_user_id` → `users.id` — on delete cascade
* `supervisor_user_id` → `users.id` — on delete set null
* `changed_by_user_id` → `users.id` — on delete restrict

### `user_activity`

Login and action trail, one row per event. Append-only.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `user_id` | `int(11)` | no |  |  |
| `activity_type` | `varchar(100)` | no |  |  |
| `activity_date` | `datetime` | no | `current_timestamp()` |  |

**Primary key** `id`  
**Indexes** `user_id` (user_id)

**Foreign keys**

* `user_id` → `users.id` — on delete cascade

### `password_resets`

One-time codes for the forgotten-password flow. Rows expire and are not cleaned up automatically.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `email` | `varchar(255)` | no |  |  |
| `otp` | `varchar(6)` | no |  |  |
| `expires_at` | `datetime` | no |  |  |
| `created_at` | `timestamp` | yes | `current_timestamp()` |  |

**Primary key** `id`

### `api_keys`

Partner API credentials. Only `key_hash` (SHA-256) is stored — the key itself is
shown once at creation and cannot be recovered. `key_prefix` is the visible part used
to identify a key in logs and in the admin screen. `scopes` is a JSON array;
`ip_allowlist` is optional and empty means any address.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `owner_user_id` | `int(11)` | no |  |  |
| `name` | `varchar(120)` | no |  |  |
| `key_prefix` | `varchar(32)` | no |  |  |
| `key_hash` | `char(64)` | no |  |  |
| `scopes` | `longtext` | no |  |  |
| `ip_allowlist` | `text` | yes |  |  |
| `rate_limit_per_min` | `int(11)` | yes |  |  |
| `status` | `enum('active','revoked')` | no | `'active'` |  |
| `expires_at` | `datetime` | yes |  |  |
| `last_used_at` | `datetime` | yes |  |  |
| `last_used_ip` | `varchar(45)` | yes |  |  |
| `created_by_user_id` | `int(11)` | no |  |  |
| `created_at` | `timestamp` | yes | `current_timestamp()` |  |
| `revoked_at` | `datetime` | yes |  |  |

**Primary key** `id`  
**Unique** `uk_api_keys_key_hash` (key_hash)  
**Indexes** `fk_api_keys_creator` (created_by_user_id), `ix_api_keys_key_prefix` (key_prefix), `ix_api_keys_owner_user_id` (owner_user_id), `ix_api_keys_status` (status)

**Foreign keys**

* `created_by_user_id` → `users.id` — on delete restrict
* `owner_user_id` → `users.id` — on delete cascade

### `api_key_usage`

One row per request made with an API key: method, path, status, latency. The source for the usage charts and for rate-limit forensics.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `bigint(20)` | no |  | auto-increment |
| `api_key_id` | `int(11)` | no |  |  |
| `method` | `varchar(10)` | no |  |  |
| `path` | `varchar(255)` | no |  |  |
| `status_code` | `smallint(6)` | no |  |  |
| `ip` | `varchar(45)` | yes |  |  |
| `user_agent` | `varchar(255)` | yes |  |  |
| `elapsed_ms` | `int(11)` | yes |  |  |
| `created_at` | `timestamp` | yes | `current_timestamp()` |  |

**Primary key** `id`  
**Indexes** `ix_api_key_usage_api_key_id_created_at` (api_key_id,created_at)

**Foreign keys**

* `api_key_id` → `api_keys.id` — on delete cascade

### `user_assigned_plans`

Which plans an agent may sell. No row for a user means no restriction is in force for them.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `user_id` | `int(11)` | no |  |  |
| `catalogue_id` | `int(11)` | no |  |  |

**Primary key** `user_id,catalogue_id`  
**Indexes** `fk_uap_catalogue` (catalogue_id), `fk_uap_user` (user_id)

**Foreign keys**

* `catalogue_id` → `catalogue.id` — on delete cascade
* `user_id` → `users.id` — on delete cascade

---

## The product catalogue

### `catalogue`

The plans. `pricing_rules` is the JSON that decides a premium: `pricingColumns`
(the destination zones), `pricing` (rows of duration bands with a price per zone),
`guarantees` (the coverage table printed on the certificate) and optional age bands.
`flat_price` is the fallback for plans that do not price by duration.
`fixed_duration_premiums` marks the fixed-table plans whose premium is printed on the
certificate. `whatsapp_enabled` is what exposes a plan in the chat.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `product_type` | `enum('Travel','Travel Inbound','Bank','Health Evacuation','Road travel')` | no |  |  |
| `name` | `varchar(100)` | no |  |  |
| `coverage` | `text` | yes |  |  |
| `coverage_summary_fr` | `text` | yes |  |  |
| `coverage_summary_en` | `text` | yes |  |  |
| `eligible_destinations` | `text` | yes |  |  |
| `durations` | `varchar(255)` | yes |  |  |
| `pricing_rules` | `longtext` | yes |  |  |
| `flat_price` | `decimal(10,2)` | yes |  |  |
| `terms` | `text` | yes |  |  |
| `country_of_residence` | `varchar(255)` | yes |  |  |
| `route_type` | `varchar(50)` | yes |  |  |
| `currency` | `varchar(3)` | yes | `'XOF'` |  |
| `partner_insurer_logo` | `varchar(512)` | yes |  |  |
| `partner_insurer` | `varchar(64)` | yes |  | Owning insurer key (e.g. gna, agico) for plan scoping |
| `theme_color` | `varchar(9)` | no | `'#E4590F'` |  |
| `extra_id_fields` | `tinyint(1)` | no | `0` |  |
| `fixed_duration_premiums` | `tinyint(1)` | no | `0` |  |
| `active` | `tinyint(1)` | yes | `1` |  |
| `whatsapp_enabled` | `tinyint(1)` | no | `0` |  |
| `created_at` | `timestamp` | yes | `current_timestamp()` |  |

**Primary key** `id`  
**Indexes** `idx_catalogue_partner_insurer` (partner_insurer), `ix_catalogue_whatsapp_enabled` (whatsapp_enabled,active)

### `destination_zones`

All 195 countries mapped to a pricing zone. Ships entirely mapped to `Worldwide`,
which is the column existing plans already use, so pricing does not move until a real
zone map is supplied. Reassignment is an update of `zone`; countries are never created
or deleted here.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `country_code` | `char(2)` | no |  | ISO 3166-1 alpha-2 |
| `country_name_en` | `varchar(120)` | no |  |  |
| `country_name_fr` | `varchar(120)` | no |  |  |
| `zone` | `varchar(60)` | no |  | Must match a catalogue.pricing_rules.pricingColumns entry |
| `active` | `tinyint(1)` | no | `1` |  |
| `created_at` | `timestamp` | no | `current_timestamp()` |  |
| `updated_at` | `timestamp` | no | `current_timestamp()` | set on update |

**Primary key** `id`  
**Unique** `uq_destination_zones_country` (country_code)  
**Indexes** `ix_destination_zones_active` (active), `ix_destination_zones_zone` (zone)

---

## Selling a policy

### `travellers`

The insured person. `passport_or_id` is the legacy plaintext column and
`passport_or_id_enc` / `passport_or_id_hash` are the encrypted replacement: AES-256-GCM
ciphertext plus a keyed HMAC used as a blind index, because ciphertext differs on every
write and could not otherwise be looked up. The plaintext column is deliberately still
present so a rollback cannot lose data; `npm run encrypt:passports` backfills and
`--clear` is what finally empties it.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `first_name` | `varchar(255)` | no |  |  |
| `last_name` | `varchar(255)` | no |  |  |
| `date_of_birth` | `date` | yes |  |  |
| `country_of_residence` | `varchar(255)` | yes |  |  |
| `gender` | `enum('Male','Female','Other')` | yes |  |  |
| `nationality` | `varchar(255)` | yes |  |  |
| `passport_or_id` | `varchar(100)` | yes |  |  |
| `phone` | `varchar(50)` | yes |  |  |
| `whatsapp_number` | `varchar(32)` | yes |  |  |
| `source` | `enum('web','whatsapp','api')` | no | `'web'` |  |
| `preferred_language` | `enum('fr','en')` | yes |  |  |
| `email` | `varchar(100)` | yes |  |  |
| `address` | `text` | yes |  |  |
| `created_at` | `timestamp` | yes | `current_timestamp()` |  |
| `passport_or_id_enc` | `text` | yes |  | AES-256-GCM ciphertext, v1.<iv>.<tag>.<ct> |
| `passport_or_id_hash` | `char(64)` | yes |  | HMAC-SHA256 blind index for exact lookup |

**Primary key** `id`  
**Indexes** `ix_travellers_passport_hash` (passport_or_id_hash), `ix_travellers_whatsapp_number` (whatsapp_number)

### `cases`

A quote. `duration_days` is generated from the dates, so it can never disagree
with them. `status` moves `Draft → AwaitingPayment → Confirmed` (or `Cancelled`);
`AwaitingPayment` exists for a chat quote whose payment has been started.
`quote_reference` is what the customer is told. `source` records which channel created
it.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `traveller_id` | `int(11)` | no |  |  |
| `destination` | `text` | no |  |  |
| `start_date` | `date` | no |  |  |
| `end_date` | `date` | no |  |  |
| `duration_days` | `int(11)` | yes |  | generated: `to_days(end_date) - to_days(start_date) + 1` |
| `selected_plan_id` | `int(11)` | no |  |  |
| `status` | `enum('Draft','Confirmed','Cancelled','AwaitingPayment')` | yes | `'Draft'` |  |
| `created_by` | `int(11)` | no |  |  |
| `group_id` | `varchar(36)` | yes |  |  |
| `quote_reference` | `varchar(50)` | yes |  |  |
| `source` | `enum('web','whatsapp','api')` | no | `'web'` |  |
| `created_at` | `timestamp` | yes | `current_timestamp()` |  |

**Primary key** `id`  
**Unique** `uq_cases_quote_reference` (quote_reference)  
**Indexes** `fk_case_plan` (selected_plan_id), `fk_case_traveller` (traveller_id), `fk_case_user` (created_by), `idx_cases_group_id` (group_id), `ix_cases_source` (source)

**Foreign keys**

* `selected_plan_id` → `catalogue.id` — on delete cascade
* `created_by` → `users.id` — on delete cascade
* `traveller_id` → `travellers.id` — on delete cascade

### `sales`

The issued policy — one per case. `active_case_lock` is a generated column
holding `case_id` while the policy is live and NULL once soft-deleted, with a UNIQUE
index over it: that is what makes "one live policy per case" a database guarantee rather
than a hope, and it is why a soft-deleted sale does not block re-issuing.
`premium_amount`/`total` are what was billed; `plan_price` is the plan's own rate.
`guarantees_total` is always 0 — coverage limits are never summed into a price.
Soft-delete is `deleted_at` plus who and why; rows are never physically removed.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `case_id` | `int(11)` | no |  |  |
| `policy_number` | `varchar(50)` | no |  |  |
| `certificate_number` | `varchar(50)` | no |  |  |
| `premium_amount` | `decimal(15,2)` | no |  |  |
| `tax` | `decimal(15,2)` | yes | `0.00` |  |
| `total` | `decimal(15,2)` | no |  |  |
| `currency` | `varchar(3)` | yes | `'XOF'` |  |
| `plan_price` | `decimal(15,2)` | yes | `0.00` |  |
| `guarantees_total` | `decimal(15,2)` | yes | `0.00` |  |
| `guarantees_details` | `longtext` | yes |  |  |
| `payment_status` | `enum('Unpaid','Paid','Partial')` | yes | `'Unpaid'` |  |
| `policy_edit_count` | `int(11)` | no | `0` |  |
| `payment_notes` | `text` | yes |  |  |
| `payment_reverse_count` | `int(11)` | no | `0` | Times Paid→Unpaid was applied by Admin (max 2) |
| `deleted_at` | `datetime` | yes |  | Soft-delete timestamp; NULL = active policy |
| `deleted_by_user_id` | `int(11)` | yes |  |  |
| `deletion_reason` | `varchar(100)` | yes |  | Test policy \| Customer desistement \| Error or duplicate \| Cancellation before reversal |
| `confirmed_at` | `datetime` | no |  |  |
| `created_at` | `timestamp` | yes | `current_timestamp()` |  |
| `received_amount` | `decimal(15,2)` | yes | `0.00` |  |
| `active_case_lock` | `int(11)` | yes |  | generated: `if(deleted_at is null,case_id,NULL)`; case_id while the sale is live, NULL once soft-deleted |
| `paid_at` | `datetime` | yes |  | When the payment was confirmed |
| `payment_method` | `varchar(40)` | yes |  | cash \| transfer \| orange \| mtn \| wave \| moov |
| `payment_reference` | `varchar(60)` | yes |  | Payment transaction reference, e.g. PAY-2026-000012 |

`confirmed_at` is NOT NULL with no default: every writer must state when the policy was confirmed.

**Primary key** `id`  
**Unique** `certificate_number` (certificate_number)  
**Unique** `policy_number` (policy_number)  
**Unique** `uq_sales_active_case` (active_case_lock)  
**Indexes** `fk_sales_deleted_by` (deleted_by_user_id), `fk_sale_case` (case_id), `idx_sales_deleted_at` (deleted_at), `ix_sales_payment_reference` (payment_reference)

**Foreign keys**

* `deleted_by_user_id` → `users.id` — on delete set null
* `case_id` → `cases.id` — on delete cascade

### `invoices`

One invoice per sale. `pdf_path` is set when a copy has been written to disk.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `sale_id` | `int(11)` | no |  |  |
| `invoice_number` | `varchar(100)` | no |  |  |
| `pdf_path` | `varchar(255)` | yes |  |  |
| `subtotal` | `decimal(15,2)` | yes |  |  |
| `tax` | `decimal(15,2)` | yes | `0.00` |  |
| `total` | `decimal(15,2)` | yes |  |  |
| `payment_status` | `enum('Unpaid','Paid','Partial')` | yes | `'Unpaid'` |  |
| `issue_date` | `datetime` | yes | `current_timestamp()` |  |
| `created_at` | `timestamp` | yes | `current_timestamp()` |  |

**Primary key** `id`  
**Unique** `invoice_number` (invoice_number)  
**Indexes** `fk_invoice_sale` (sale_id)

**Foreign keys**

* `sale_id` → `sales.id` — on delete cascade

### `certificates`

One certificate per sale. `public_token` is the credential behind the QR code and
the WhatsApp document link — unguessable, and the only thing protecting that URL.
`issued_snapshot` is the frozen copy of what the certificate said at issuance (traveller,
trip, plan, pricing, payment), which is what stops a later catalogue edit from changing a
document a customer already holds. `pdf_path` is a filesystem path relative to the backend
working directory (`storage/certificates/…`), **not** a URL: that directory is not
web-served, because certificate numbers are sequential and a certificate carries a
passport number.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `sale_id` | `int(11)` | no |  |  |
| `certificate_number` | `varchar(100)` | no |  |  |
| `public_token` | `varchar(64)` | yes |  |  |
| `pdf_path` | `varchar(255)` | yes |  |  |
| `issue_date` | `datetime` | yes | `current_timestamp()` |  |
| `coverage_summary` | `text` | yes |  |  |
| `created_at` | `timestamp` | yes | `current_timestamp()` |  |
| `issued_snapshot` | `longtext` | yes |  | Frozen copy of what the certificate said when issued |

**Primary key** `id`  
**Unique** `certificate_number` (certificate_number)  
**Unique** `uq_certificates_public_token` (public_token)  
**Indexes** `fk_certificate_sale` (sale_id)

**Foreign keys**

* `sale_id` → `sales.id` — on delete cascade

### `policy_sequences`

The counters behind policy, invoice and certificate numbers. One row per
(`seq_key`, `period`), incremented atomically with
`INSERT … ON DUPLICATE KEY UPDATE current_value = LAST_INSERT_ID(current_value + 1)`.
**This table deliberately has no AUTO_INCREMENT column**: MySQL would overwrite the
session's `LAST_INSERT_ID` with the generated row id and the allocator would hand out the
wrong number. Changing that is a data-integrity bug, not a tidy-up.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `seq_key` | `varchar(40)` | no |  | policy \| invoice \| certificate |
| `period` | `varchar(10)` | no | `'ALL'` | ALL, 2026, or 2026-10 |
| `current_value` | `bigint(20) unsigned` | no | `0` |  |
| `created_at` | `timestamp` | no | `current_timestamp()` |  |
| `updated_at` | `timestamp` | no | `current_timestamp()` | set on update |

**Primary key** `seq_key,period`

---

## Taking money

### `payment_transactions`

One row per payment attempt. `status` is a state machine —
`pending → initiated → awaiting_confirmation → completed | failed | expired | cancelled` —
and all four endings are terminal. `completed` is write-once: a late `failed` from a
provider cannot un-pay a policy. `status_history` is an append-only JSON trail of every
move with who made it. `idempotency_key` is ours (one per attempt) and `provider_tx_id`
is theirs, UNIQUE per provider so a replayed callback cannot create a second payment.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `bigint(20)` | no |  | auto-increment |
| `reference` | `varchar(60)` | no |  | Our reference, shown to the customer |
| `case_id` | `int(11)` | yes |  | The quote being paid for |
| `sale_id` | `int(11)` | yes |  | Set once the policy is issued |
| `provider` | `varchar(30)` | no |  | orange \| mtn \| wave \| moov \| mock |
| `provider_tx_id` | `varchar(190)` | yes |  | The provider's own id; UNIQUE so a replayed callback cannot duplicate |
| `idempotency_key` | `varchar(190)` | no |  | Ours, one per payment attempt |
| `msisdn` | `varchar(32)` | yes |  | Number charged; may differ from the WhatsApp number |
| `amount` | `decimal(15,2)` | no |  |  |
| `currency` | `varchar(3)` | no | `'XOF'` |  |
| `status` | `enum('pending','initiated','awaiting_confirmation','completed','failed','expired','cancelled')` | no | `'pending'` |  |
| `failure_code` | `varchar(60)` | yes |  | Internal code, mapped from the provider's |
| `failure_detail` | `varchar(500)` | yes |  |  |
| `status_history` | `longtext` | yes |  | Append-only [{from,to,at,by,note}] |
| `wa_session_id` | `bigint(20)` | yes |  | Conversation to wake when this settles |
| `initiated_at` | `datetime` | yes |  |  |
| `completed_at` | `datetime` | yes |  |  |
| `expires_at` | `datetime` | yes |  | When the sweeper may mark it expired |
| `created_at` | `timestamp` | no | `current_timestamp()` |  |
| `updated_at` | `timestamp` | no | `current_timestamp()` | set on update |

**Primary key** `id`  
**Unique** `uq_payment_idempotency` (provider,idempotency_key)  
**Unique** `uq_payment_provider_tx` (provider,provider_tx_id)  
**Unique** `uq_payment_reference` (reference)  
**Indexes** `ix_payment_case` (case_id), `ix_payment_created` (created_at), `ix_payment_sale` (sale_id), `ix_payment_status_expires` (status,expires_at)

### `payment_callbacks`

Every callback a provider sends, stored before it is interpreted.
`raw_body` is a MEDIUMBLOB holding the **exact bytes**, not a parsed or re-encoded copy,
because the signature is computed over those bytes and a dispute is argued with them.
`signature_valid`, `processed` and `duplicate` record what we concluded and what we did.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `bigint(20)` | no |  | auto-increment |
| `provider` | `varchar(30)` | no |  |  |
| `transaction_id` | `bigint(20)` | yes |  | Resolved after parsing; NULL when we could not match it |
| `provider_tx_id` | `varchar(190)` | yes |  |  |
| `signature_header` | `varchar(255)` | yes |  | As received, for dispute evidence |
| `signature_valid` | `tinyint(1)` | no | `0` |  |
| `raw_body` | `mediumblob` | no |  | Exact bytes, never a parsed copy |
| `content_type` | `varchar(120)` | yes |  |  |
| `remote_ip` | `varchar(64)` | yes |  |  |
| `processed` | `tinyint(1)` | no | `0` |  |
| `duplicate` | `tinyint(1)` | no | `0` | Seen this provider_tx_id before |
| `process_error` | `varchar(500)` | yes |  |  |
| `received_at` | `timestamp` | no | `current_timestamp()` |  |

**Primary key** `id`  
**Indexes** `ix_callbacks_provider_tx` (provider,provider_tx_id), `ix_callbacks_received` (received_at), `ix_callbacks_tx` (transaction_id)

---

## The WhatsApp channel

### `whatsapp_sessions`

One conversation. `collected_data` is the answers so far, `step_history`
the path taken (which is what BACK walks). `active_lock` is generated as the number while
the session is active and NULL otherwise, with a UNIQUE index: one active conversation per
number, enforced by the database. `payment_transaction_id` is the payment this conversation
is parked on, which is how a callback knows whom to wake.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `bigint(20)` | no |  | auto-increment |
| `wa_number` | `varchar(32)` | no |  | E.164, no + prefix, as Meta sends it |
| `wa_profile_name` | `varchar(255)` | yes |  |  |
| `language` | `enum('fr','en')` | no | `'fr'` |  |
| `flow_key` | `varchar(60)` | no | `'purchase'` |  |
| `current_step` | `varchar(80)` | yes |  |  |
| `step_history` | `longtext` | yes |  | Visited step keys, newest last — powers BACK |
| `collected_data` | `longtext` | yes |  | Partial traveller/case data gathered so far |
| `retry_count` | `smallint(5) unsigned` | no | `0` |  |
| `status` | `enum('active','completed','expired','cancelled','escalated')` | no | `'active'` |  |
| `customer_message_count` | `int(10) unsigned` | no | `0` | Instrumentation for the 6-8 message target |
| `traveller_id` | `int(11)` | yes |  |  |
| `case_id` | `int(11)` | yes |  |  |
| `quote_reference` | `varchar(50)` | yes |  |  |
| `active_lock` | `varchar(32)` | yes |  | generated: `if(status = 'active',wa_number,NULL)` |
| `last_activity_at` | `datetime` | no | `current_timestamp()` |  |
| `expires_at` | `datetime` | yes |  |  |
| `created_at` | `timestamp` | no | `current_timestamp()` |  |
| `updated_at` | `timestamp` | no | `current_timestamp()` | set on update |
| `payment_transaction_id` | `bigint(20)` | yes |  | The payment this conversation is parked on |

**Primary key** `id`  
**Unique** `uq_whatsapp_sessions_active` (active_lock)  
**Indexes** `fk_whatsapp_sessions_traveller` (traveller_id), `ix_sessions_payment_tx` (payment_transaction_id), `ix_whatsapp_sessions_case` (case_id), `ix_whatsapp_sessions_expires` (expires_at), `ix_whatsapp_sessions_number` (wa_number), `ix_whatsapp_sessions_status` (status)

**Foreign keys**

* `traveller_id` → `travellers.id` — on delete set null
* `case_id` → `cases.id` — on delete set null

### `whatsapp_messages`

The full transcript, inbound and outbound, written before the engine runs
so a crash still leaves evidence of what the customer sent. `wa_message_id` is UNIQUE,
which gives free deduplication of Meta's webhook retries. Subject to the retention policy
(`npm run prune:messages`).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `bigint(20)` | no |  | auto-increment |
| `session_id` | `bigint(20)` | yes |  |  |
| `wa_number` | `varchar(32)` | no |  |  |
| `direction` | `enum('inbound','outbound')` | no |  |  |
| `wa_message_id` | `varchar(128)` | yes |  |  |
| `message_type` | `varchar(40)` | no | `'text'` |  |
| `body` | `text` | yes |  | Human-readable text, for support and debugging |
| `payload` | `longtext` | yes |  | Full normalised payload |
| `step_key` | `varchar(80)` | yes |  | Flow step this message belongs to |
| `status` | `varchar(40)` | yes |  | queued \| sent \| delivered \| read \| failed |
| `error_code` | `varchar(40)` | yes |  |  |
| `error_message` | `varchar(500)` | yes |  |  |
| `created_at` | `timestamp` | no | `current_timestamp()` |  |

**Primary key** `id`  
**Unique** `uq_whatsapp_messages_wa_id` (wa_message_id)  
**Indexes** `ix_whatsapp_messages_number` (wa_number,created_at), `ix_whatsapp_messages_session` (session_id,created_at), `ix_whatsapp_messages_status` (status)

**Foreign keys**

* `session_id` → `whatsapp_sessions.id` — on delete set null

### `whatsapp_flows`

An optional superadmin override of the conversation definition. With no active
row the built-in flow is used; a stored `definition` is merged over it and unknown steps
and parsers are ignored rather than trusted.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `flow_key` | `varchar(60)` | no |  |  |
| `name` | `varchar(160)` | no |  |  |
| `description` | `varchar(500)` | yes |  |  |
| `definition` | `longtext` | no |  | Ordered step definitions: prompt, input type, validation, next/prev |
| `version` | `int(10) unsigned` | no | `1` |  |
| `active` | `tinyint(1)` | no | `1` |  |
| `updated_by_user_id` | `int(11)` | yes |  |  |
| `created_at` | `timestamp` | no | `current_timestamp()` |  |
| `updated_at` | `timestamp` | no | `current_timestamp()` | set on update |

**Primary key** `id`  
**Unique** `uq_whatsapp_flows_key` (flow_key)  
**Indexes** `ix_whatsapp_flows_updated_by` (updated_by_user_id)

**Foreign keys**

* `updated_by_user_id` → `users.id` — on delete set null

---

## Platform plumbing

### `app_settings`

Every runtime setting the client can change without a deploy: WhatsApp
credentials, payment provider credentials, number formats, branding, templates.
`is_secret = 1` means `setting_value` holds AES-256-GCM ciphertext (`v1.<iv>.<tag>.<ct>`)
encrypted with `SETTINGS_ENCRYPTION_KEY`; without that key the API refuses to save a
secret rather than storing it in the clear, and reads come back masked.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `setting_key` | `varchar(120)` | no |  | Namespaced, e.g. whatsapp.access_token |
| `setting_value` | `text` | yes |  | Plaintext, or AES-256-GCM ciphertext when is_secret = 1 |
| `value_type` | `enum('string','number','boolean','json')` | no | `'string'` |  |
| `is_secret` | `tinyint(1)` | no | `0` |  |
| `description` | `varchar(500)` | yes |  |  |
| `updated_by_user_id` | `int(11)` | yes |  |  |
| `created_at` | `timestamp` | no | `current_timestamp()` |  |
| `updated_at` | `timestamp` | no | `current_timestamp()` | set on update |

**Primary key** `id`  
**Unique** `uq_app_settings_key` (setting_key)  
**Indexes** `ix_app_settings_updated_by` (updated_by_user_id)

**Foreign keys**

* `updated_by_user_id` → `users.id` — on delete set null

### `idempotency_keys`

Replay protection for the money paths. UNIQUE on (`scope`,
`idempotency_key`); `request_fingerprint` is a hash of the canonical body, so the same key
sent with a different body is rejected instead of silently returning the first answer. A
completed row carries the recorded response, replayed with `Idempotent-Replay: true`.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `bigint(20)` | no |  | auto-increment |
| `idempotency_key` | `varchar(255)` | no |  |  |
| `scope` | `varchar(80)` | no |  | Route identity, e.g. sales:create |
| `request_fingerprint` | `char(64)` | no |  | SHA-256 of the canonical request body |
| `status` | `enum('in_progress','completed','failed')` | no | `'in_progress'` |  |
| `response_status` | `int(11)` | yes |  |  |
| `response_body` | `longtext` | yes |  |  |
| `actor_user_id` | `int(11)` | yes |  |  |
| `api_key_id` | `int(11)` | yes |  |  |
| `created_at` | `timestamp` | no | `current_timestamp()` |  |
| `completed_at` | `datetime` | yes |  |  |

**Primary key** `id`  
**Unique** `uq_idempotency_scope_key` (scope,idempotency_key)  
**Indexes** `ix_idempotency_created` (created_at)

### `schema_migrations`

The migration ledger: filename, SHA-256 checksum, and whether it was
applied or marked as a baseline. The checksum is enforced — editing a migration that has
already run is refused rather than reapplied.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `filename` | `varchar(255)` | no |  |  |
| `checksum` | `char(64)` | no |  |  |
| `state` | `enum('applied','baseline')` | no | `'applied'` |  |
| `applied_at` | `timestamp` | no | `current_timestamp()` |  |
| `execution_ms` | `int(10) unsigned` | yes |  |  |

**Primary key** `id`  
**Unique** `uq_schema_migrations_filename` (filename)

### `contractual_documents`

The two downloadable contract documents (`full`, `brief`) and where their files live.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `int(11)` | no |  | auto-increment |
| `doc_key` | `enum('full','brief')` | no |  | full = Version Complète; brief = Version Brève |
| `title` | `varchar(255)` | no |  |  |
| `description` | `varchar(1000)` | no |  |  |
| `file_path` | `varchar(500)` | no |  | Public path under /uploads/… |
| `original_filename` | `varchar(255)` | yes |  |  |
| `mime_type` | `varchar(120)` | yes |  |  |
| `file_size` | `int(10) unsigned` | yes |  |  |
| `uploaded_by_user_id` | `int(11)` | yes |  |  |
| `created_at` | `timestamp` | no | `current_timestamp()` |  |
| `updated_at` | `timestamp` | no | `current_timestamp()` | set on update |

**Primary key** `id`  
**Unique** `uq_contractual_doc_key` (doc_key)  
**Indexes** `idx_contractual_uploaded_by` (uploaded_by_user_id)

**Foreign keys**

* `uploaded_by_user_id` → `users.id` — on delete set null

---

## Views

### `sales_ledger`

A read-only join of sales, cases, travellers and plans, used by the reporting
screens. No data of its own.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `sale_id` | `int(11)` | no | `0` |  |
| `case_id` | `int(11)` | no |  |  |
| `agent_id` | `int(11)` | no |  |  |
| `traveller_name` | `varchar(511)` | yes |  |  |
| `traveller_phone` | `varchar(50)` | yes |  |  |
| `plan_name` | `varchar(100)` | yes |  |  |
| `product_type` | `enum('Travel','Travel Inbound','Bank','Health Evacuation','Road travel')` | yes |  |  |
| `policy_number` | `varchar(50)` | no |  |  |
| `certificate_number` | `varchar(50)` | no |  |  |
| `premium_amount` | `decimal(15,2)` | no |  |  |
| `tax` | `decimal(15,2)` | yes | `0.00` |  |
| `total` | `decimal(15,2)` | no |  |  |
| `payment_status` | `enum('Unpaid','Paid','Partial')` | yes | `'Unpaid'` |  |
| `confirmed_at` | `datetime` | no |  |  |

---

## Where the sensitive data is

| What | Where | How it is protected |
|---|---|---|
| Passport / ID numbers | `travellers.passport_or_id_enc` (+ `_hash`) | AES-256-GCM under `SETTINGS_ENCRYPTION_KEY`; the hash is a keyed HMAC used only for exact lookup. The legacy plaintext column still exists until cleared. |
| WhatsApp and payment credentials | `app_settings` rows with `is_secret = 1` | AES-256-GCM; never returned by the API in the clear, only masked. |
| API keys | `api_keys.key_hash` | SHA-256 of the key. The key itself is never stored. |
| Login passwords | `users.password` | bcrypt. |
| Customer conversations | `whatsapp_messages.body` / `payload` | Transcripts contain personal data, which is why `whatsapp:read` is a separate API scope from `cases:read`. Pruned by retention policy. |
| Certificate links | `certificates.public_token` | The token IS the credential: that URL needs no login. Treat it as a secret. |
| Stored certificate PDFs | `storage/certificates/` on disk, path in `certificates.pdf_path` | Outside the web-served `uploads/` tree on purpose — the file names are sequential and the documents carry passport numbers. Back it up; never serve it. |
| Provider callbacks | `payment_callbacks.raw_body` | Kept verbatim as dispute evidence, including whatever the provider chose to send. |

Logging redacts all of the above by field name; see `utils/logger.js`.

---

## Things that look wrong and are not

* **`policy_sequences` has no AUTO_INCREMENT column.** Deliberate. See the table above.
* **`sales.guarantees_total` is always 0.** Coverage limits are not money and are never
  summed into a premium. The limits live in `guarantees_details`.
* **`travellers.passport_or_id` still holds plaintext on older rows.** The encrypted
  columns are the readers' source of truth; the old column is emptied only by
  `npm run encrypt:passports --clear`, after a backup.
* **`sales.active_case_lock` and `whatsapp_sessions.active_lock` are never written by the
  application.** They are generated, and the UNIQUE index over them is the actual rule.
* **`certificates.issued_snapshot` duplicates data that is also in other tables.** That is
  the point: it has to survive an edit to those tables.

