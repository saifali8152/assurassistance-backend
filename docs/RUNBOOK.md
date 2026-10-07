# Operations runbook

Everything that has to be done to the running system, and what to do when it
misbehaves. Companion to `DEPLOY_HOSTINGER_VPS.md`, which covers first-time
setup.

---

## 1. Deploying a change

```bash
ssh <your-vps>
cd /opt/assurassistance-backend

# 1. Know what you are rolling back TO, before you change anything.
git rev-parse HEAD > /tmp/previous-release.txt
cat /tmp/previous-release.txt

# 2. Back up first. Every deploy that touches migrations must have one.
bash scripts/backup-db.sh

# 2b. The database is no longer the whole story: issued certificate PDFs live on
#     disk under storage/ (section 5). Include it in the nightly backup, not in
#     every deploy.
#     tar -czf ~/backups/storage-$(date +%F).tar.gz storage/ uploads/

# 3. Take the code.
git pull

# 4. Install anything new.
npm install --omit=dev

# 5. Apply migrations. The runner is idempotent — re-running is a no-op.
npm run migrate:status      # what is pending
npm run migrate

# 6. Restart.
pm2 restart backend
pm2 logs backend --lines 50

# 7. Prove it.
curl -s https://<your-api-host>/api/health | head -20
```

The frontend is separate: build locally, upload `dist/` by FTP. Filenames are
fixed, so an upload overwrites in place.

---

## 2. Rolling back

**There was no documented rollback procedure before this file.** This is it.

### Backend, code only — no migration in the release

```bash
cd /opt/assurassistance-backend
git log --oneline -5                      # find the commit you were on
git checkout <previous-commit>
npm install --omit=dev
pm2 restart backend
curl -s https://<your-api-host>/api/health
```

Two minutes. Nothing else is needed, because the database never changed.

### Backend, when the release included a migration

Every migration in this project is **additive** — a new table, a new column, a
new index, never a drop or a rewrite — specifically so that the previous code
keeps running against the new schema. So the rollback is the same as above:
check out the old commit and restart. **Leave the migration in place.** Do not
try to undo it.

The one thing that would break this is a migration that removes or rewrites
data. `scripts/encryptPassports.js --clear` is the only tool in the repo that
does, and it is a deliberate, separate, operator-run step — never part of a
deploy.

### Frontend

```bash
# You need the previous build. Keep one:
#   before each upload, download the live dist/ into dist-backup-<date>/
```

Because the build uses fixed asset filenames, rolling the frontend back means
re-uploading the previous `dist/` over the live one. **Keep the last known-good
build** — without it there is nothing to roll back to.

### When the database itself is wrong

```bash
# List what you have
ls -la /var/backups/assurassistance/

# Restore into a SCRATCH database first and look at it. Never straight over live.
zcat /var/backups/assurassistance/<file>.sql.gz | mysql -u root restore_check
mysql -u root restore_check -e "SELECT COUNT(*) FROM sales; SELECT MAX(confirmed_at) FROM sales;"
```

Only once you have looked at it, and with the application stopped
(`pm2 stop backend`), restore over the live database.

### Deciding

| Symptom | Action |
|---|---|
| 500s on one endpoint | Roll the code back. Keep the migration. |
| Health check 503 | Database, not code. Check MySQL is up before touching the release. |
| Payments failing at one provider | Nothing to roll back. Switch that provider off in Payment Settings and the flow stops offering it. |
| WhatsApp silent | Check `/api/health`, then Meta's webhook configuration. Switching `whatsapp.enabled` off is instant and needs no deploy. |
| Wrong data written | Stop the app first, then restore. A rollback with the app running races you. |

---

## 3. Scheduled jobs

```cron
*/2 * * * * cd /opt/assurassistance-backend && /usr/bin/node scripts/pollPayments.js  >> /var/log/aas-poll.log 2>&1
*   * * * * cd /opt/assurassistance-backend && /usr/bin/node scripts/sweepPayments.js >> /var/log/aas-sweep.log 2>&1
10 6 * * *  cd /opt/assurassistance-backend && /usr/bin/node scripts/dailySummary.js  >> /var/log/aas-summary.log 2>&1
15 3 * * 0  cd /opt/assurassistance-backend && /usr/bin/node scripts/pruneMessages.js >> /var/log/aas-prune.log 2>&1
30 2 * * *  cd /opt/assurassistance-backend && bash scripts/backup-db.sh             >> /var/log/aas-backup.log 2>&1
```

The order of the first two matters: **poll before sweep**. The poller asks the
provider what really happened; the sweeper gives up. Running the sweeper alone
would expire payments whose callback was merely lost — taking a customer's money
and issuing nothing.

Each is a standalone script, never an in-process timer, because the app runs
under PM2 and an interval would fire once per worker.

---

## 4. Provider runbook

### Adding a provider

1. The client obtains a merchant account and credentials from the operator.
2. Admin → **Payment Settings** → that provider's card. Fill in base URL,
   merchant id, API user, API key, callback secret, the countries it covers and
   the number prefixes it issues.
3. Give the operator the callback URL:
   `https://<your-api-host>/api/payments/webhook/<provider>`
4. Switch the provider on. The card shows **Ready** only when nothing is
   missing; until then it names the blank fields.
5. Test with a real low-value payment. Sandbox success does not predict
   production.

### When a provider stops working

```bash
# What is the system seeing?
mysql -u root assurassistance -e "
  SELECT status, failure_code, COUNT(*) FROM payment_transactions
   WHERE created_at > NOW() - INTERVAL 1 HOUR GROUP BY status, failure_code;"

# Are the callbacks even arriving?
mysql -u root assurassistance -e "
  SELECT provider, signature_valid, processed, COUNT(*) FROM payment_callbacks
   WHERE received_at > NOW() - INTERVAL 1 HOUR GROUP BY provider, signature_valid, processed;"
```

| What you see | What it means | What to do |
|---|---|---|
| No callback rows at all | The provider is not reaching us | Check the callback URL in their dashboard and that the host resolves publicly |
| Rows with `signature_valid = 0` | The callback secret does not match | Re-enter it in Payment Settings; the provider may have rotated it |
| Rows with `transaction_id IS NULL` | Callbacks arriving for payments we do not have | Usually a sandbox key pointed at production, or the reverse |
| Many `provider_unavailable` | Their outage | Switch that provider off; customers are offered the others |
| Many `insufficient_funds` | Not a fault | Nothing to do |
| Payments stuck in `awaiting_confirmation` | The poller is not running | `npm run poll:payments:dry` and check the cron |

Switching a provider off is a settings change, takes effect within 30 seconds,
and needs no deploy. That is the first move in almost every incident.

### Money taken, no policy issued

The one case worth interrupting someone for. The daily summary flags it.

```bash
mysql -u root assurassistance -e "
  SELECT id, reference, provider, amount, case_id, created_at
    FROM payment_transactions
   WHERE status = 'completed' AND sale_id IS NULL;"
```

Then, for each, check the application log for `payment_issue_policy` — it says
why issuance failed (`not_priceable`, `case_gone`). Issuing the policy by hand
from the case is safe: issuance is idempotent, so if it had already succeeded
you would get the existing policy back rather than a second one.

---

## 5. Stored certificate PDFs

An issued certificate is rendered once and written to
`storage/certificates/<certificate number>-<fr|en>.pdf`. Everything afterwards —
the admin download, the public link WhatsApp fetches, the group ZIP — serves
that file. `certificates.pdf_path` records the first rendition written.

**`storage/` is not `uploads/`, and that is the point.** `uploads/` is served
publicly by Nginx/Express, and certificate numbers are sequential — a stored
certificate there would be downloadable by anyone willing to count, and it carries
the traveller's passport number. Do not serve `storage/`, do not symlink it into
the web root, and do not move these files into `uploads/`. The only public route to
a certificate is the one gated by its 48-character token.

Why it matters operationally:

* **`storage/` belongs in the backup.** The database alone no longer holds
  everything a customer was given. The files are reproducible (see below), but
  only while the plan still exists in the catalogue.
* **A layout, logo or wording change does not reach already-issued
  certificates**, by design — the document a travelling customer may be asked to
  show at a border must not move under them.

To force a re-render after a deliberate layout fix, delete the files. The next
request renders and stores them again:

```bash
# One policy
rm -f storage/certificates/CERT-2026-000123-*.pdf

# Everything issued (only when you mean it)
rm -f storage/certificates/*.pdf
```

Deleting is always safe: nothing reads these files without falling back to a
render. Deleting is also the only supported way to change them — never edit a
stored PDF in place, because the database has no record of that having happened.

Certificates issued before milestone 3 carry no frozen snapshot and are
therefore **not** stored: they keep rendering live, exactly as they always did.
Nothing needs to be done about that; an old policy has no file and does not need
one.

If the disk fills, rendering still works — storing is best effort and a failure
is logged, not raised at the customer.

---

## 6. Secrets

| Variable | Why it matters |
|---|---|
| `SETTINGS_ENCRYPTION_KEY` | Without it **no credential can be saved at all** — the settings screen refuses rather than storing plaintext. `openssl rand -hex 32`. Changing it makes every stored secret unreadable. |
| `PUBLIC_API_URL` | Used to build the certificate link WhatsApp fetches and the provider callback URL. Wrong or missing means certificates silently never arrive. |
| `ALERT_EMAIL` | Where failures are reported. Unset means nothing tells anyone. |
| `SUMMARY_EMAIL` | Where the daily summary goes. Falls back to `ALERT_EMAIL`. |

Rotating a provider credential is a settings change, not a deploy.
