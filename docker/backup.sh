#!/bin/sh
# Өдөр бүр 03:00 (Улаанбаатар): database-ийн backup (14 хоног) + барааны зургийн хуулбар.
# Зургийн файлууд өөрчлөгддөггүй (UUID нэр) тул зөвхөн шинэ файлыг хуулна — хурдан, дискийг хэмнэнэ.
set -e
mkdir -p /backups/media
run_backup() {
  f="/backups/erp-$(date +%Y%m%d-%H%M).sql.gz"
  echo "[backup] $f"
  pg_dump -h db -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner | gzip > "$f.tmp" && mv "$f.tmp" "$f"
  find /backups -maxdepth 1 -name 'erp-*.sql.gz' -mtime +14 -delete
  if [ -d /media ]; then
    cp -a -n /media/. /backups/media/ 2>/dev/null || cp -a /media/. /backups/media/
    echo "[backup] зураг: $(find /backups/media -type f | wc -l) файл"
  fi
}
if [ -n "$BACKUP_NOW" ]; then run_backup; exit 0; fi
while true; do
  if [ "$(date +%H%M)" = "0300" ]; then run_backup; sleep 61; fi
  sleep 30
done
