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
  # Зөвхөн шинэ файлыг хуулна (BusyBox cp -n хавтас байвал бүхэлд нь алгасдаг тул файл бүрээр шалгана)
  if [ -d /uploads/products ]; then
    (cd /uploads && find products -type f) | while read -r f; do
      if [ ! -e "/backups/media/$f" ]; then
        mkdir -p "/backups/media/$(dirname "$f")" && cp -p "/uploads/$f" "/backups/media/$f"
      fi
    done
  fi
  echo "[backup] зураг: $(find /backups/media -type f | wc -l) файл"

}
if [ -n "$BACKUP_NOW" ]; then run_backup; exit 0; fi
while true; do
  if [ "$(date +%H%M)" = "0300" ]; then run_backup; sleep 61; fi
  sleep 30
done
