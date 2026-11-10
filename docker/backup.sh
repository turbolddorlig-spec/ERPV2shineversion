#!/bin/sh
# Өдөр бүр 03:00 (Улаанбаатар) database-ийн backup авч, 14 хоног хадгална.
set -e
mkdir -p /backups
while true; do
  now=$(date +%H%M)
  if [ "$now" = "0300" ] || [ -n "$BACKUP_NOW" ]; then
    f="/backups/erp-$(date +%Y%m%d-%H%M).sql.gz"
    echo "[backup] $f"
    pg_dump -h db -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner | gzip > "$f.tmp" && mv "$f.tmp" "$f"
    find /backups -name 'erp-*.sql.gz' -mtime +14 -delete
    [ -n "$BACKUP_NOW" ] && exit 0
    sleep 61
  fi
  sleep 30
done
