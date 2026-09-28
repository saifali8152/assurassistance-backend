#!/usr/bin/env bash
#
# Nightly MySQL backup for the AssurAssistance VPS.
#
# RUN THIS ON THE SERVER, not from a laptop. Install with:
#
#   cp scripts/backup-db.sh ~/backup-db.sh
#   chmod +x ~/backup-db.sh
#   sudo mkdir -p /var/backups/mysql && sudo chown "$USER" /var/backups/mysql
#   crontab -e
#   0 2 * * *  /home/YOURUSER/backup-db.sh >> /var/log/aas-backup.log 2>&1
#
# CREDENTIALS go in ~/.my.cnf with chmod 600 — never on the command line, where
# any user on the box can read them out of `ps`:
#
#   [client]
#   user=assurapp
#   password=YOUR_DB_PASSWORD
#
set -euo pipefail

DB_NAME="${DB_NAME:-assurassistance}"
OUT_DIR="${OUT_DIR:-/var/backups/mysql}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"
MIN_BYTES="${MIN_BYTES:-10000}"
DEFAULTS_FILE="${DEFAULTS_FILE:-$HOME/.my.cnf}"

STAMP="$(date +%F_%H%M)"
TARGET="${OUT_DIR}/${DB_NAME}_${STAMP}.sql.gz"

# mysqldump failing mid-pipe aborts the script under `set -e` BEFORE the size
# check below ever runs, which would leave a half-written archive sitting in the
# backup directory looking like a real backup. Remove it on any failure.
trap 'rm -f "$TARGET"' ERR

log() { echo "$(date -Is) backup: $*"; }

[ -r "$DEFAULTS_FILE" ] || { log "FATAL: $DEFAULTS_FILE not readable"; exit 1; }
mkdir -p "$OUT_DIR"

# --single-transaction dumps InnoDB consistently WITHOUT locking the tables, so
# the site keeps serving customers while the dump runs. --quick streams row by
# row instead of buffering the whole result set in memory.
mysqldump \
  --defaults-extra-file="$DEFAULTS_FILE" \
  --single-transaction \
  --quick \
  --routines \
  --triggers \
  --events \
  --set-gtid-purged=OFF \
  "$DB_NAME" | gzip -9 > "$TARGET"

# A dump that "succeeded" but is 200 bytes is a failure that will sit unnoticed
# until the day it is needed. Fail loudly instead.
SIZE="$(stat -c%s "$TARGET" 2>/dev/null || stat -f%z "$TARGET")"
if [ "$SIZE" -lt "$MIN_BYTES" ]; then
  log "FATAL: dump is only ${SIZE} bytes — removing it and failing"
  rm -f "$TARGET"
  exit 1
fi

# Prove the archive is readable now, rather than discovering it is truncated
# during an incident.
gzip -t "$TARGET"

DELETED="$(find "$OUT_DIR" -name "${DB_NAME}_*.sql.gz" -mtime "+${RETAIN_DAYS}" -print -delete | wc -l)"

trap - ERR

log "ok ${TARGET} (${SIZE} bytes), pruned ${DELETED} old backup(s), keeping ${RETAIN_DAYS} days"

# ---------------------------------------------------------------------------
# OFF-SITE COPY — uncomment one. A backup on the same disk as the database is
# not a backup: it dies with the disk, and with the VPS.
#
# rclone copy "$TARGET" remote:assurassistance-backups/ --quiet
# aws s3 cp "$TARGET" s3://your-bucket/assurassistance/ --only-show-errors
# scp -q "$TARGET" backup@another-host:/backups/assurassistance/
