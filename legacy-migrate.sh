#!/usr/bin/env bash
# zahialga• ERP V2 — хуучин ERP-ээс өгөгдөл шилжүүлэх (#182). Хуучин системд огт хүрэхгүй — зөвхөн хуулбар файлаас.
#
# Бэлтгэл: ~/migration/old-erp-db.sql.gz (хуучин database-ийн хуулбар), ~/migration/old-erp-images.tar.gz (барааны зураг, заавал биш)
#
#   ./legacy-migrate.sh analyze   — хуулбарыг уншиж ТООЛНО (юу ч бичихгүй): ажилчид, бараа, захиалга төлөвөөр
#   ./legacy-migrate.sh trial     — ТУРШИЛТ: одоогийн системийн хуулбар (erp_trial) руу оруулж, http://<IP>:3001-д түр нээнэ.
#                                   Ажиллаж буй систем огт өөрчлөгдөхгүй. SMS, Meta, Gmail, Drive тохиргоо туршилтад хасагдана.
#   ./legacy-migrate.sh real      — ЖИНХЭНЭ: backup → апп түр зогсоно → оруулна → асна («ШИЛЖҮҮЛ» гэж бичиж баталгаажуулна)
#   ./legacy-migrate.sh cleanup   — туршилтын систем, түр database, хуулбар файлуудыг устгана
#
# Эзний шийдвэр: 11/18–11/20-нд ҮҮССЭН захиалга орохгүй (хуучин ERP-д дуусгана); нийлүүлэгч орохгүй; үлдэгдэл 0 (тоолж оруулна).
set -euo pipefail
cd "$(dirname "$0")"
say() { printf '\n\033[1;33m▶ %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31mАЛДАА: %s\033[0m\n' "$1"; exit 1; }
[ -f .env ] || die ".env алга — ERP-ийн хавтсанд ажиллуулна уу"
M="${MIGRATION_DIR:-$HOME/migration}"
SKIP_FROM="${SKIP_FROM:-2026-11-18}"; SKIP_TO="${SKIP_TO:-2026-11-20}"
PGP=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
url() { printf 'postgresql://erp:%s@db:5432/%s?schema=public&connection_limit=12' "$PGP" "$1"; }
psqlq() { docker compose exec -T db psql -U erp -v ON_ERROR_STOP=1 -q "$@"; }
dbexists() { [ "$(docker compose exec -T db psql -U erp -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$1'")" = "1" ]; }

restore_legacy() {
  [ -f "$M/old-erp-db.sql.gz" ] || die "$M/old-erp-db.sql.gz алга — хуучин серверээс хуулбараа зөөнө үү"
  if dbexists legacy && [ "${1:-}" != "fresh" ]; then echo "Хуучин хуулбар (legacy) аль хэдийн сэргээгдсэн — дахин ашиглана"; return; fi
  say "Хуучин database-ийн хуулбарыг түр database (legacy) руу сэргээж байна"
  psqlq -d postgres -c 'DROP DATABASE IF EXISTS legacy' -c 'CREATE DATABASE legacy'
  gunzip -c "$M/old-erp-db.sql.gz" | docker compose exec -T db psql -U erp -d legacy -q >/dev/null 2>"$M/restore.log" || true
  n=$(docker compose exec -T db psql -U erp -d legacy -tAc 'SELECT count(*) FROM "Order"' 2>/dev/null || echo 0)
  [ "${n:-0}" -gt 0 ] 2>/dev/null || die "Хуулбараас захиалга олдсонгүй — $M/restore.log-г шалгана уу"
  echo "Хуучин хуулбарт $n захиалга байна"
}
images() {
  if [ -f "$M/old-erp-images.tar.gz" ] && [ ! -d "$M/images" ]; then
    say "Барааны зургийг задалж байна"; mkdir -p "$M/images" && tar xzf "$M/old-erp-images.tar.gz" -C "$M/images"
  fi
  [ -d "$M/images" ] && chmod -R a+rX "$M/images" || true
}
run_migrate() { # $1 = зорилтот database, $2 = зургийн volume, үлдсэн нь нэмэлт сонголт
  local target="$1" vol="$2"; shift 2
  local imgargs=(); [ -d "$M/images" ] && imgargs=(-v "$M/images:/legacy-images:ro")
  docker compose run --rm --no-deps -T -e DATABASE_URL="$(url "$target")" -e UPLOAD_DIR=/mig-uploads -v "$vol:/mig-uploads" "${imgargs[@]}" \
    --entrypoint node app dist/legacy-migrate.mjs --legacy "$(url legacy)" ${imgargs:+--images /legacy-images} --skip-from "$SKIP_FROM" --skip-to "$SKIP_TO" "$@"
}

case "${1:-}" in
  analyze)
    restore_legacy "${2:-}"
    say "Хуучин өгөгдлийг тоолж байна (юу ч бичихгүй)"
    docker compose run --rm --no-deps -T -e DATABASE_URL="$(url erp)" --entrypoint node app dist/legacy-migrate.mjs --legacy "$(url legacy)" --skip-from "$SKIP_FROM" --skip-to "$SKIP_TO" --analyze | tee "$M/analyze.txt" | sed -n '/ТАЙЛАН/,$p'
    echo; echo "Тайлан: $M/analyze.txt — тоонуудыг (захиалга, бараа, ажилчид) Claude-д илгээнэ үү (утас, нэр БИШ)."
    ;;
  trial)
    restore_legacy "${2:-}"; images
    say "Туршилтын database (erp_trial) — одоогийн системийн хуулбар (Супер админ, тохиргоо)"
    docker rm -f erp-trial >/dev/null 2>&1 || true
    psqlq -d postgres -c 'DROP DATABASE IF EXISTS erp_trial' -c 'CREATE DATABASE erp_trial' -c "ALTER DATABASE erp_trial SET timezone TO 'UTC'"
    docker compose exec -T db sh -c 'pg_dump -U erp -d erp --no-owner | psql -U erp -d erp_trial -q' >/dev/null
    # Туршилтаас жинхэнэ мессеж, Meta, банк, Drive руу юу ч явахгүй
    psqlq -d erp_trial -c "DELETE FROM \"AppSetting\" WHERE key IN ('smsConfig','metaPixelId','metaAccessToken','metaTestEventCode','bank.gmail','bank.incoming','driveBackup','driveOauthState')"
    docker volume create erp_trial_uploads >/dev/null
    docker run --rm -v erp_trial_uploads:/d alpine chown -R 1001:1001 /d
    say "Хуучин өгөгдлийг туршилт руу оруулж байна (олон захиалгатай бол 10–30 минут)"
    run_migrate erp_trial erp_trial_uploads | tee "$M/trial-report.txt" | grep -E '^\[шилжүүлэлт\]|ТАЙЛАН' || true
    IP=$(hostname -I | awk '{print $1}')
    say "Туршилтын системийг http://$IP:3001 дээр нээж байна (ажлын системээс тусдаа)"
    docker compose run -d --no-deps --name erp-trial -p 3001:3000 -e DATABASE_URL="$(url erp_trial)" -e DISABLE_JOBS=1 -e COOKIE_SECURE=false \
      -e APP_URL="http://$IP:3001" -e UPLOAD_DIR=/mig-uploads -v erp_trial_uploads:/mig-uploads app >/dev/null
    echo "Тайлан: $M/trial-report.txt  ·  Туршилт: http://$IP:3001 (хуучин утас, нууц үгээрээ нэвтэрнэ)"
    echo "Шалгаж дууссаны дараа: ./legacy-migrate.sh real   (эсвэл засвар хэрэгтэй бол Claude-д тайлангийн ТООНУУДЫГ илгээнэ)"
    ;;
  real)
    [ -f "$M/old-erp-db.sql.gz" ] || die "$M/old-erp-db.sql.gz алга"
    printf '\n\033[1;31m⚠ ЖИНХЭНЭ шилжүүлэлт: хуучин өгөгдөл ажиллаж буй систем рүү орно.\033[0m\n'
    read -rp "Үргэлжлүүлэх бол том үсгээр ШИЛЖҮҮЛ гэж бичнэ үү: " ANS
    [ "$ANS" = "ШИЛЖҮҮЛ" ] || { echo "Цуцаллаа."; exit 1; }
    restore_legacy "${2:-}"; images
    say "Шилжүүлэхийн өмнөх backup"
    docker compose build backup >/dev/null
    BK=$(docker compose run --rm -T -e BACKUP_NOW=update backup </dev/null | tail -n 1) || die "backup бүтсэнгүй — юу ч өөрчлөгдсөнгүй"
    echo "$BK"
    say "Апп-ыг түр зогсоож байна"
    docker compose stop app
    V=$(docker volume ls -q | grep -E '_uploads$' | grep -v trial | head -n 1)
    [ -n "$V" ] || { docker compose start app; die "зургийн volume олдсонгүй"; }
    say "Оруулж байна (олон захиалгатай бол 10–30 минут)"
    if ! run_migrate erp "$V" | tee "$M/real-report.txt" | grep -E '^\[шилжүүлэлт\]|ТАЙЛАН'; then echo "(тайланг шалгана уу)"; fi
    docker compose start app
    say "Дууслаа. Тайлан: $M/real-report.txt"
    echo "Асуудал гарвал буцаах: ./restore.sh backups/${BK#/backups/}"
    ;;
  cleanup)
    read -rp "Туршилтын систем, түр database (legacy, erp_trial), $M доторх хуулбар файлуудыг устгах уу? (тийм/үгүй): " ANS
    [ "$ANS" = "тийм" ] || { echo "Цуцаллаа."; exit 1; }
    docker rm -f erp-trial >/dev/null 2>&1 || true
    psqlq -d postgres -c 'DROP DATABASE IF EXISTS erp_trial' -c 'DROP DATABASE IF EXISTS legacy'
    docker volume rm erp_trial_uploads >/dev/null 2>&1 || true
    rm -rf "$M"
    say "Цэвэрлэгдлээ (хуучин серверийн ~/migration-ийг тэнд бас устгана уу)"
    ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
