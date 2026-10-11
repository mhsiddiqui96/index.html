#!/usr/bin/env bash
# ডাটাবেসের নিরাপদ ব্যাকআপ: /opt/wa-desk-backups/wa-desk-YYYYmmdd-HHMMSS.tar.gz
# প্রতিদিন অটো ব্যাকআপ চাইলে (রাত ৩টা):
#   echo "0 3 * * * root bash /opt/wa-desk/whatsapp-saas/deploy/backup.sh" | sudo tee /etc/cron.d/wa-desk-backup
set -euo pipefail
cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-/opt/wa-desk-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"

# Flush the SQLite WAL into the main file so the copy is consistent, then archive data + .env.
docker compose exec -T app node --no-warnings -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/app/data/app.db');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();"
CID="$(docker compose ps -q app)"
TMP="$(mktemp -d)"
docker cp "$CID:/app/data" "$TMP/data"
cp .env "$TMP/.env"
tar -czf "$BACKUP_DIR/wa-desk-$STAMP.tar.gz" -C "$TMP" data .env
rm -rf "$TMP"
chmod 600 "$BACKUP_DIR/wa-desk-$STAMP.tar.gz"
find "$BACKUP_DIR" -name 'wa-desk-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "ব্যাকআপ তৈরি হয়েছে: $BACKUP_DIR/wa-desk-$STAMP.tar.gz"
