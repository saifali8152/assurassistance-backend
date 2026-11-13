# Phase 2 (M4 claims + M5 admin) — going live on the VPS

Everything in here is run **by you, on the server**. Nothing in this release
deletes a row, rewrites an existing value or drops anything. Claims ship
**switched off**: customers see no change until you switch them on in the admin
panel (§9), after testing.

Work top to bottom. Each step ends with a **Check**. If a check fails, stop and
fix it before moving on, because the later steps assume the earlier ones worked.

Paths assume the backend lives at `/opt/assurassistance-backend`. Adjust if yours
differs (`pm2 info backend` shows the real one under **exec cwd**).

---

## 0. Before you touch anything (do not skip)

```bash
cd /opt/assurassistance-backend
bash scripts/backup-db.sh
ls -lh /var/backups/mysql | tail -3
```

**Check:** the dump is from the last few minutes and holds data, not just the schema.

```bash
F=/var/backups/mysql/<the file it just printed>
gzip -t "$F" && echo "archive intact"
zgrep -c "INSERT INTO" "$F"     # must be well above zero
```

Also keep a copy of the files you are about to replace:

```bash
tar -czf ~/pre-phase2-$(date +%F).tar.gz -C /opt/assurassistance-backend \
  --exclude=node_modules --exclude=uploads --exclude=storage .
cp .env .env.bak.$(date +%F)
```

---

## 1. Upload the backend

**By git:** push from your machine (your call, your commit), then on the server
`git pull`.

**By SFTP/FileZilla:** upload the whole `backend/` folder *except* these, which
must stay as they are on the server:

- `node_modules/`
- `.env`
- `uploads/`
- `storage/`

Then, either way:

```bash
cd /opt/assurassistance-backend
npm install --omit=dev
```

Phase 2 adds no new dependency; this catches a half-uploaded `package.json` now
rather than after a restart.

---

## 2. Migrate

```bash
npm run migrate:status
```

**Check:** it lists **11 pending** files and nothing else:

```
m4_01_feature_flags.sql        m4_07_whatsapp_claim_link.sql
m4_02_claim_tables.sql         m4_08_claim_settings.sql
m4_03_claim_categories.sql     m5_01_access_roles.sql
m4_04_external_policies.sql    m5_02_admin_audit.sql
m4_05_claim_security.sql       m5_03_login_lockout.sql
m4_06_claim_notifications.sql
```

If it lists more or fewer, stop: the upload is incomplete.

```bash
npm run migrate:dry      # prints the statements, runs nothing — look for ERROR
npm run migrate
```

**Check:** every file reports applied. Run `npm run migrate` a second time — it
must say *Database is up to date*. (The files are re-runnable; if your terminal
drops mid-way, just run it again.)

What the migrations do to **existing** tables — and nothing else:

| Table | Change |
|---|---|
| `users` | three new nullable/defaulted columns: `access_role_id` (custom role, empty for everyone), `failed_login_count` (0), `locked_until` (empty) |
| `whatsapp_sessions` | two new nullable columns: `claim_id`, `parked_purchase`, and an index |
| `app_settings` | new `claims.*` rows only (`INSERT IGNORE` — an existing row is never overwritten) |

Everything else is new tables: `feature_flags` (with `claims_enabled` **= 0**),
`feature_flag_allowlist`, `feature_flag_audit`, `claims`, `claim_documents`,
`claim_status_history`, `claim_categories` (seeded with the default categories),
`external_policies`, `claim_validation_attempts`, `claim_notifications`,
`access_roles` (the four built-in roles + "Claims handler"),
`access_role_permissions`, `admin_audit_log`. No foreign key points at a live table.

Existing users keep exactly what they had: the four built-in roles get no new
permission; only the main administrator sees the new screens until you give
someone a role (§8).

---

## 3. The `storage/claims` folder

Claim documents (photos, PDFs) are stored **encrypted** on our server, under
`storage/claims/YYYY/MM/`. Like `storage/certificates`, it must be writable by
the app and **never served by the web server**.

```bash
cd /opt/assurassistance-backend
mkdir -p storage/claims
pm2 info backend | grep -i "exec user"
chown -R <pm2-user>:<pm2-user> storage
chmod -R 750 storage
sudo -u <pm2-user> touch storage/claims/.probe && echo "writable OK" && rm -f storage/claims/.probe
curl -s -o /dev/null -w "%{http_code}\n" https://https://backend-api.assurassistancepro.org/storage/claims/   # must be 404
```

To keep them elsewhere, set `CLAIMS_STORAGE_DIR=/absolute/path` in `.env` — same
two rules apply.

**Backups:** your M3 file backup already covers `storage/`. If it does not,
add it — a claim document exists nowhere else:

```bash
tar -czf ~/backups/files-$(date +%F).tar.gz -C /opt/assurassistance-backend storage uploads
```

The files are useless without `SETTINGS_ENCRYPTION_KEY` (they are encrypted with
it), so the key must be kept safe separately from the backup — as it already is
for M3.

---

## 4. Environment variables

```bash
nano .env
grep -E "^(SETTINGS_ENCRYPTION_KEY|PUBLIC_API_URL|EMAIL_HOST|EMAIL_FROM)=" .env | sed 's/=.*/= (set)/'
```

**Must already be set (M3) — do not change them:**

- `SETTINGS_ENCRYPTION_KEY` — encrypts claim documents and imported-policy
  passports. **Never change it**: everything encrypted with it becomes unreadable.
- `PUBLIC_API_URL` — builds the signed document links.

**Needed for claim notification emails:**

- `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_SECURE`, `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_FROM` — the same
  SMTP settings the platform already uses. Phase 2 fixes a bug where scripts run
  by cron could not send mail even with these set.

**Add (recommended):**

```ini
# Link in the claim emails ("open in the admin panel")
ADMIN_URL=https://assurassistancepro.org
```

**Optional (defaults are fine):**

```ini
# CLAIMS_STORAGE_DIR=/opt/assurassistance-backend/storage/claims
# LOGIN_MAX_FAILURES=5      # wrong passwords before an account locks (min 3)
# LOGIN_LOCK_MINUTES=15     # how long it stays locked
```

Restart and verify:

```bash
pm2 restart backend
pm2 logs backend --lines 40
curl -s https://backend-api.assurassistancepro.org/api/health | head -40
```

**Check:** the logs show no error and health reports the database reachable and
encryption ready.

---

## 5. Cron — four new lines

```bash
crontab -e
```

Add (keep your existing M3 lines):

```cron
*/2 * * * *  cd /opt/assurassistance-backend && /usr/bin/node scripts/sendClaimNotifications.js >> /var/log/aas-claim-mail.log 2>&1
*/5 * * * *  cd /opt/assurassistance-backend && /usr/bin/node scripts/refetchClaimDocuments.js  >> /var/log/aas-claim-docs.log 2>&1
20 * * * *   cd /opt/assurassistance-backend && /usr/bin/node scripts/abandonClaimDrafts.js     >> /var/log/aas-claim-drafts.log 2>&1
40 3 * * 0   cd /opt/assurassistance-backend && /usr/bin/node scripts/purgeClaimDocuments.js    >> /var/log/aas-claim-retention.log 2>&1
```

| Job | What it does | Deletes? |
|---|---|---|
| `sendClaimNotifications` | Emails the claims team about new claims (urgent first). Recipients: Admin → Claims settings → notification emails. | No |
| `refetchClaimDocuments` | Retries a document whose download from WhatsApp failed for a temporary reason. | No |
| `abandonClaimDrafts` | Marks claims left unfinished for 48 h (setting) as `abandoned`. | No — status only |
| `purgeClaimDocuments` | Removes stored **files** of claims closed/abandoned longer than the retention setting. **The setting is empty by default, so it does nothing** until the client decides a retention period. Rows are kept, marked `purged`. | Files only, and only if configured |

Run each once by hand first:

```bash
sudo touch /var/log/aas-claim-{mail,docs,drafts,retention}.log
sudo chown <cron-user> /var/log/aas-claim-*.log
npm run claims:notify:dry
npm run claims:refetch-documents
npm run claims:abandon-drafts:dry
npm run claims:purge-documents:dry
```

**Check:** each exits without error and reports nothing to do (there are no
claims yet — that is the correct answer).

---

## 6. The frontend

On your machine (the build reads the production API URL by default):

```bash
cd frontend
npm run build
```

Upload `dist/` by FTP. Filenames are fixed, so the upload overwrites in place and
`.htaccess` survives.

Optional: the admin panel signs a user out after 30 minutes without activity.
To change it, build with `VITE_IDLE_TIMEOUT_MINUTES=45 npm run build` (minimum 2).

**Check:** hard-refresh the admin panel as the main administrator. The menu shows a
**Claims** section (badge "inactive") with Claims, Claims settings, Categories &
documents, Activation & test numbers; **Roles & permissions** under People &
partners; **Imported policies** under Operations; **WhatsApp simulator** under
System.

---

## 7. Confirm claims are OFF

Admin → **Activation & test numbers** must say **"Off — only test numbers see
claims"**. Or, read-only:

```sql
SELECT flag_key, enabled FROM feature_flags;   -- claims_enabled must be 0
```

With it off, a customer typing *SINISTRE* on WhatsApp gets a neutral "coming
soon" and the purchase flow is unchanged.

---

## 8. Set up, then test without customers

The client's administrator can do all of this in the panel — the checklist at the top of
`CLAIMS_ADMIN_GUIDE_EN.md` / `_FR.md` walks them through it.

1. **Roles** — Admin → Roles & permissions → *Who has what*: give the "Claims
   handler" role to the staff who will handle claims (or create a custom role).
2. **Notification emails** — Admin → Claims settings → notification emails.
3. **Categories** — review the default categories and required documents with the
   client (Admin → Categories & documents).
4. **Simulator** — Admin → WhatsApp simulator: file a full claim against a test
   policy. Nothing is sent to WhatsApp, no payment starts, no case is written;
   the claim is marked *test*.
5. **Test numbers** — once WhatsApp is connected, add your own number under
   Activation & test numbers and file a real claim from your phone. It is a test
   claim (Claims → *Include test claims*).

---

## 9. Go live (when the client agrees)

Admin → Activation & test numbers → **Switch on**, type **ON** to confirm. The
change is immediate and recorded in the history with your name. Switching off is
the same, with **OFF**; submitted claims stay and can still be handled.

Remove tester numbers from the allowlist afterwards.

---

## 10. Partner API

- Replace the partner package with the new `assurassistance-api-integration.zip`
  (adds `GET /api/claims` and `GET /api/claims/{reference}`, scope `claims:read`,
  status only).
- **Revoke the old key.** The previous zip's `CREDENTIALS.txt` contained a real
  `aas_live_…` key (owner user 1). Admin → System → API Keys → revoke it, and
  issue partners new keys through a secure channel. The new template is blank.
- To let a partner follow claims, edit its key and tick **Claims → claims:read**.

---

## If something goes wrong

- **Turn claims off** (§9) — this alone returns customers to the pre-Phase-2
  experience. Nothing else needs undoing.
- **Code rollback:** restore `~/pre-phase2-<date>.tar.gz`, `npm install --omit=dev`,
  `pm2 restart backend`. The new tables and columns can stay — the old code
  ignores them. **Do not drop them**: they hold claims.
- **Database restore** is only for real data damage, and would lose any claim made
  since the backup. `docs/RUNBOOK.md` §2 has the procedure.
