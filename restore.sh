#!/usr/bin/env bash
# zahialga• ERP V2 — нөөц хуулбараас СЭРГЭЭХ (#132)
#   ./restore.sh                  — сервер дээрх хуулбаруудаас сонгоно
#   ./restore.sh --drive          — Google Drive дээрх хуулбаруудаас сонгоно (татаж авна)
#   ./restore.sh <файлын зам>     — тодорхой файл
# Аюулгүй: (1) одоогийн database-ийн хуулбарыг эхлээд авна, (2) шинэ database-д сэргээж шалгана,
# (3) зөвхөн амжилттай бол солино — хуучин нь «erp_old_<огноо>» нэрээр үлдэнэ (буцаах боломжтой).
set -euo pipefail
cd "$(dirname "$0")"
say() { printf '\n\033[1;33m▶ %s\033[0m\n' "$1"; }
# docker compose run нь stdin-ийг (бичсэн хариултыг) идэхгүй байх ёстой
dcr() { docker compose run --rm -T "$@" </dev/null; }
die() { printf '\n\033[1;31mАЛДАА: %s\033[0m\n' "$1"; exit 1; }
[ -f .env ] || die ".env алга — энэ серверт систем суугаагүй байна"
mkdir -p backups/restore

pick() { # stdin: мөр бүр нэг файл → дугаар сонгуулна
  mapfile -t L
  [ "${#L[@]}" -gt 0 ] || die "Хуулбар олдсонгүй"
  for i in "${!L[@]}"; do printf '  %2d) %s\n' "$((i + 1))" "${L[$i]}"; done
  read -rp "Дугаар сонгоно уу: " n < /dev/tty
  [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge 1 ] && [ "$n" -le "${#L[@]}" ] || die "Буруу дугаар"
  echo "${L[$((n - 1))]}" > backups/restore/.pick
}

FILE=""
if [ "${1:-}" = "--drive" ]; then
  [ -f backups/.rclone/rclone.conf ] || die "Google Drive холбогдоогүй (./setup-drive-backup.sh)"
  REMOTE=$(grep -E '^DRIVE_REMOTE=' .env | cut -d= -f2- || true); REMOTE=${REMOTE:-gdrive:zahialga-backup}
  say "Google Drive дээрх хуулбарууд"
  dcr --entrypoint sh backup -c "export RCLONE_CONFIG=/backups/.rclone/rclone.conf; for d in daily weekly monthly update; do rclone lsf --files-only \"$REMOTE/\$d\" 2>/dev/null | sed \"s#^#\$d/#\"; done" | sort -r | pick
  sel=$(cat backups/restore/.pick)
  say "Татаж байна: $sel"
  dcr --entrypoint sh backup -c "export RCLONE_CONFIG=/backups/.rclone/rclone.conf; rclone copyto \"$REMOTE/$sel\" \"/backups/restore/$(basename "$sel")\""
  FILE="backups/restore/$(basename "$sel")"
elif [ -n "${1:-}" ]; then
  FILE="$1"
else
  say "Сервер дээрх хуулбарууд (шинэ нь дээрээ)"
  (cd backups && ls -1 daily/*.sql.gz monthly/*.sql.gz update/*.sql.gz restore/*.sql.gz 2>/dev/null) | sort -t/ -k2 -r | pick
  FILE="backups/$(cat backups/restore/.pick)"
fi
[ -f "$FILE" ] || die "Файл олдсонгүй: $FILE"
case "$FILE" in backups/*) ;; *) cp "$FILE" backups/restore/ && FILE="backups/restore/$(basename "$FILE")" ;; esac
IN="/backups/${FILE#backups/}"

say "Файлыг шалгаж байна: $FILE"
dcr --entrypoint sh backup -c "gzip -t '$IN' && gunzip -c '$IN' | tail -c 400 | grep -q 'PostgreSQL database dump complete'" || die "Файл эвдэрсэн эсвэл дутуу — сэргээхгүй"

echo
echo "  Одоогийн БҮХ өгөгдөл энэ хуулбараар СОЛИГДОНО: $(basename "$FILE")"
echo "  (Одоогийн database устахгүй — erp_old_... нэрээр хадгалагдана.)"
read -rp "  Үргэлжлүүлэх бол СЭРГЭЭХ гэж бичнэ үү: " ok
[ "$ok" = "СЭРГЭЭХ" ] || die "Цуцаллаа"

say "1/5 Одоогийн database-ийн хуулбар (аюулгүйн үүднээс)"
dcr -e BACKUP_NOW=update backup | tail -n 1

say "2/5 Шинэ database-д сэргээж байна (хэдэн минут)"
PSQL="psql -h db -U erp -v ON_ERROR_STOP=1 -q"
dcr --entrypoint sh backup -c "
  $PSQL -d postgres -c 'DROP DATABASE IF EXISTS erp_restore' &&
  $PSQL -d postgres -c 'CREATE DATABASE erp_restore' &&
  gunzip -c '$IN' | $PSQL -d erp_restore --single-transaction >/dev/null" || die "Сэргээх үед алдаа — одоогийн database хөндөгдөөгүй"

say "3/5 Шалгаж байна"
CNT=$(dcr --entrypoint sh backup -c "psql -h db -U erp -d erp_restore -Atc 'SELECT count(*) FROM \"_prisma_migrations\"' 2>/dev/null; psql -h db -U erp -d erp_restore -Atc 'SELECT count(*) FROM \"User\"'; psql -h db -U erp -d erp_restore -Atc 'SELECT count(*) FROM \"Order\"'" | tr '\n' ' ')
echo "  migration / хэрэглэгч / захиалга: $CNT"
set -- $CNT
[ "${2:-0}" -gt 0 ] || die "Сэргээсэн database-д хэрэглэгч алга — солихгүй"

say "4/5 Солиж байна (апп түр зогсоно)"
OLD="erp_old_$(date +%Y%m%d_%H%M%S)"
docker compose stop app >/dev/null
dcr --entrypoint sh backup -c "
  $PSQL -d postgres -c \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('erp','erp_restore') AND pid <> pg_backend_pid()\" >/dev/null &&
  $PSQL -d postgres -c 'ALTER DATABASE erp RENAME TO $OLD' &&
  $PSQL -d postgres -c 'ALTER DATABASE erp_restore RENAME TO erp'" || { docker compose start app; die "Солих үед алдаа — одоогийн database хэвээр"; }

say "5/5 Апп эхлүүлж байна"
docker compose up -d app >/dev/null
ok=0
for i in $(seq 1 60); do
  if docker compose exec -T app node healthcheck.mjs >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
if [ "$ok" = 1 ]; then
  say "Амжилттай сэргээлээ: $(basename "$FILE")"
  echo "  Өмнөх database: $OLD (шаардлагагүй болсон үед: docker compose exec db dropdb -U erp $OLD)"
else
  echo "АЛДАА: апп эхэлсэнгүй. Өмнөх рүү буцаах:"
  echo "  docker compose stop app && docker compose exec db psql -U erp -d postgres -c 'ALTER DATABASE erp RENAME TO erp_failed' -c 'ALTER DATABASE $OLD RENAME TO erp' && docker compose up -d app"
  exit 1
fi
