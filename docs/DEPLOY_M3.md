# Milestone 3 — going live on the VPS

Everything in here is run **by you, on the server**. Nothing in this file touches
the database destructively and nothing deletes a file.

Work top to bottom. Each step ends with a check — if the check fails, stop there
and fix it before moving on, because the later steps assume the earlier ones
worked.

Paths assume the backend lives at `/opt/assurassistance-backend`. Adjust if yours
differs (`pm2 info backend` shows the real one under **exec cwd**).

---

## 0. Before you touch anything (5 minutes, do not skip)

```bash
cd /opt/assurassistance-backend

# What are you rolling back TO? Write it down somewhere outside the server.
git rev-parse HEAD 2>/dev/null || echo "not a git deploy — note the current folder backup instead"

# A database backup you have actually verified exists.
bash scripts/backup-db.sh
ls -lh ~/backups | tail -3
```

**Check:** you have a dump file from the last few minutes with a sane size (not
0 bytes, not a few hundred bytes). If `backup-db.sh` writes somewhere else, look
there — the path is at the top of the script.

This matters more than usual this time, because step 5 rewrites a column in
`travellers`.

---

## 1. Upload the backend, then migrate

### 1a. Get the code onto the server

**If you deploy by git:** push from your machine (your call, your commit), then
on the server:

```bash
cd /opt/assurassistance-backend
git pull
npm install --omit=dev
```

**If you deploy by SFTP/FileZilla:** upload the whole `backend/` folder *except*
these, which must stay as they are on the server:

- `node_modules/`
- `.env`
- `uploads/`
- `storage/`

Then on the server:

```bash
cd /opt/assurassistance-backend
npm install --omit=dev
```

`npm install` is needed either way — not because M3 adds a dependency (it does
not), but because an interrupted upload of `package.json` is the kind of thing
you want to find now rather than after a restart.

### 1b. Look before you migrate

```bash
npm run migrate:status
```

**Check:** it lists 8 pending files, `m3_01_policy_sequences.sql` through
`m3_08_traveller_pii.sql`. If it lists more or fewer, stop — the upload is
incomplete.

```bash
npm run migrate:dry
```

This prints the statements without running them. Read the output for the word
`ERROR`. There should be none.

### 1c. Migrate

```bash
npm run migrate
```

**Check:** every file reports applied, and the output ends without an error.

Then read one specific line in the output — `m3_03_sales_single_active.sql`
reports `cases_with_more_than_one_live_sale`:

- **`0`** — it added the unique index. Good, nothing to do.
- **anything above 0** — it added the column, **skipped the index**, and changed
  no data. That is deliberate: the live database already contains more than one
  live policy for some case, and forcing the index would have failed or required
  deleting a row. Send me the number and I will tell you which cases; you then
  soft-delete the duplicate from the admin panel and re-run `npm run migrate`,
  which lands the index. **Do not delete rows by hand in MySQL.**

These migrations are additive and re-runnable: running `npm run migrate` twice is
a no-op, so if you lose your terminal mid-way, just run it again.

---

## 2. The `storage/` folder

This is new in M3. Issued certificate PDFs are written there and served from
there afterwards, so an issued document can no longer change under a customer.

```bash
cd /opt/assurassistance-backend
mkdir -p storage/certificates

# Owned by whoever PM2 runs the app as. Check that first:
pm2 info backend | grep -i "exec user\|script path"
# then, substituting the right user:
chown -R <pm2-user>:<pm2-user> storage
chmod -R 750 storage
```

**Check — it must be writable by the app and invisible to the web:**

```bash
# writable
sudo -u <pm2-user> touch storage/certificates/.probe && echo "writable OK" && rm -f storage/certificates/.probe

# NOT served — this must return 404, not 200
curl -s -o /dev/null -w "%{http_code}\n" https://<your-api-host>/storage/certificates/
```

`uploads/` is served publicly by design (partner logos appear on certificates).
`storage/` must not be. Three rules:

1. No Nginx `location /storage` block, and no `alias`/`root` pointing at it.
2. No symlink from the web root into it.
3. Never move these files into `uploads/`. Certificate numbers are sequential —
   `CERT-2026-000042` tells you `000041` exists — and each PDF carries the
   traveller's passport number. Under `uploads/` they would be downloadable by
   counting.

The only public route to a certificate stays
`/api/sales/certificate/public/<48-character token>/pdf`.

### Add it to the nightly backup

`storage/` now holds things the database does not. Append to your backup cron
(see step 4) or to `backup-db.sh`:

```bash
tar -czf ~/backups/files-$(date +%F).tar.gz -C /opt/assurassistance-backend storage uploads
```

The files are reproducible — deleting one makes the next request re-render it —
but only while the plan still exists in the catalogue. Back them up.

---

## 3. Environment variables

```bash
cd /opt/assurassistance-backend
cp .env .env.bak.$(date +%F)   # keep an escape hatch
nano .env
```

### Add these four

```ini
# Where failures are reported. Unset means nothing tells anyone.
ALERT_EMAIL=ops@assurassistance.org

# Where the daily transaction summary goes. Falls back to ALERT_EMAIL.
SUMMARY_EMAIL=ops@assurassistance.org

# Don't repeat the same alert more often than this (minutes).
ALERT_WINDOW_MINUTES=30

# Hard ceiling on alert emails per hour, whatever happens.
ALERT_MAX_PER_HOUR=20
```

The last two exist so that a provider having a bad night sends you a handful of
useful emails instead of four thousand.

### Leave this one alone

```ini
# PAYMENT_ALLOW_MOCK=1
```

Do **not** set it in production. It enables the fake payment provider, which
confirms payments that never happened and would issue real policies for free.
Confirm it is absent:

```bash
grep -n "PAYMENT_ALLOW_MOCK" .env || echo "absent — correct"
```

### Confirm these two are already set

```bash
grep -E "^(PUBLIC_API_URL|SETTINGS_ENCRYPTION_KEY|BASE_URL)=" .env | sed 's/=.*/= (set)/'
```

- **`PUBLIC_API_URL`** — must be the public https URL of the API, no trailing
  slash. It builds the certificate link WhatsApp fetches and the callback URLs
  you give the operators. Wrong or missing means certificates silently never
  arrive.
- **`SETTINGS_ENCRYPTION_KEY`** — 64 hex characters (`openssl rand -hex 32`).
  Without it the settings screen **refuses** to save a provider credential
  rather than storing it in the clear, and step 5 cannot run at all. If it is
  already set, **never change it** — every stored secret becomes unreadable.

### Restart and verify

```bash
pm2 restart backend
pm2 logs backend --lines 40
curl -s https://<your-api-host>/api/health | head -40
```

**Check:** the health response reports the database reachable and encryption
ready. If it reports encryption not configured, `SETTINGS_ENCRYPTION_KEY` is
missing or malformed — fix that before step 5.

---

## 4. Cron

```bash
crontab -e
```

```cron
*/2 * * * * cd /opt/assurassistance-backend && /usr/bin/node scripts/pollPayments.js  >> /var/log/aas-poll.log 2>&1
*   * * * * cd /opt/assurassistance-backend && /usr/bin/node scripts/sweepPayments.js >> /var/log/aas-sweep.log 2>&1
10 6 * * *  cd /opt/assurassistance-backend && /usr/bin/node scripts/dailySummary.js  >> /var/log/aas-summary.log 2>&1
15 3 * * 0  cd /opt/assurassistance-backend && /usr/bin/node scripts/pruneMessages.js >> /var/log/aas-prune.log 2>&1
30 2 * * *  cd /opt/assurassistance-backend && bash scripts/backup-db.sh             >> /var/log/aas-backup.log 2>&1
```

**The order of the first two is load-bearing.** The poller asks the provider what
actually happened; the sweeper gives up on stale payments. Sweeper-only would
expire payments whose callback was merely lost — taking a customer's money and
issuing nothing.

Run each once by hand first, in dry-run where it exists:

```bash
cd /opt/assurassistance-backend
npm run poll:payments:dry
npm run sweep:payments:dry
npm run summary:daily:dry
npm run prune:messages:dry
```

**Check:** each prints what it *would* do and exits 0. With no payments in the
system yet they will say they found nothing — that is the correct answer, and it
still proves the script runs, connects and reads.

Make sure the log files are writable by the cron user, or you will debug silence:

```bash
sudo touch /var/log/aas-{poll,sweep,summary,prune,backup}.log
sudo chown <cron-user> /var/log/aas-*.log
```

---

## 5. Encrypt the passport numbers

M3 adds `travellers.passport_or_id_enc` (AES-256-GCM) and
`passport_or_id_hash` (a keyed hash, so an exact lookup still works even though
the ciphertext differs on every write). The old plaintext column stays in place
until you explicitly clear it, so this is reversible right up to the last
command.

**Requires `SETTINGS_ENCRYPTION_KEY` to be set, and the step-3 health check to
pass.** If the key is ever lost or changed, the encrypted values are gone — and
if you have already cleared the plaintext, they are gone for good. So:

```bash
cd /opt/assurassistance-backend

# 1. See what it would do. Changes nothing.
npm run encrypt:passports:dry
```

**Check:** it reports a row count that looks like your real traveller count.

```bash
# 2. Write the encrypted column and the hash. Plaintext still untouched.
npm run encrypt:passports
```

**Check:** the reported number encrypted matches the dry run, with 0 failures.
Now confirm the app reads them correctly **before** clearing anything — open two
or three policies in the admin panel and check the passport number still shows,
and download one certificate and check the number printed on it.

```bash
# 3. Only once you have confirmed the above, and only after a fresh backup.
bash scripts/backup-db.sh
npm run encrypt:passports:clear
```

**Check:** passport numbers still display in the admin panel and on
certificates, read now from the encrypted column alone.

There is no hurry on step 3. Leaving the plaintext column populated for a week
while you watch the app is a perfectly reasonable choice; nothing else depends
on it being empty.

---

## 6. The frontend (do this too — your `dist/` is stale)

As of 7 October your built `dist/` is from 06-10 11:32, but `Payments.tsx`,
`App.tsx`, `Layout.tsx` and both translation files changed at 12:40–12:41. The
bundle on the server has Payment Settings but **not** the Payments screen — which
is the screen you need for the live payment tests.

On your machine:

```bash
cd frontend
npm run build
```

Then upload `dist/` by FTP. Filenames are fixed (no content hashing), so the
upload overwrites in place and `.htaccess` survives.

**Check:** hard-refresh the admin panel and confirm three entries under
**System**: API Keys, Payments, Payment Settings.

---

## 7. Point Meta and the operators at the server

- **Meta webhook:** `https://<your-api-host>/api/whatsapp/webhook`, with the
  verify token you set in Admin → WhatsApp Settings. Meta will call the GET
  handshake immediately; if it fails, the token does not match.
- **Each payment operator:**
  `https://<your-api-host>/api/payments/webhook/orange` (and `/mtn`, `/wave`,
  `/moov`). Give each operator only its own URL.

---

## 8. First live payment, per operator

Once the client's credentials are in Admin → Payment Settings, for each operator:

1. Enable just that one operator.
2. Buy a policy through WhatsApp with your own number and the smallest amount
   the plan allows.
3. Open **Payments** in the admin panel and look at the two banners:
   - **Red, "paid without a policy"** — money arrived, no policy came out. Stop
     selling through that operator and send me the transaction reference.
   - **Amber, "stuck"** — started and never resolved either way.
4. Open the transaction's detail drawer. It shows the status history and the raw
   callback the operator sent us, verified-or-not. That is what I need to see if
   anything looks wrong.
5. Confirm the certificate arrived in WhatsApp as a PDF.

Both banners empty, policy issued, certificate delivered — that operator is live.

---

## If something goes wrong

`docs/RUNBOOK.md` has the rollback procedures: §2 for code and for a release that
included a migration, §4 for an operator that stops working, and §4's
"money taken, no policy issued" procedure. Issuing a policy by hand from the case
is safe — issuance is idempotent, so if it had already succeeded you get the
existing policy back rather than a second one.
