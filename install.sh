#!/usr/bin/env bash
# zahialga• ERP V2 — АНХНЫ суулгалт (шинэ сервер дээр нэг удаа ажиллуулна)
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1;33m▶ %s\033[0m\n' "$1"; }

command -v docker >/dev/null || { echo "Docker суугаагүй байна. Эхлээд Docker суулгана уу: https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "'docker compose' ажиллахгүй байна."; exit 1; }

if [ -f .env ]; then
  echo ".env аль хэдийн байна — суулгалт өмнө нь хийгдсэн. Шинэчлэхдээ ./update.sh ажиллуулна уу."
  exit 1
fi

say "Тохиргоо"
read -rp "Домэйн (жишээ: v2.erpzahialga.com, байхгүй бол хоосон орхино): " DOMAIN
read -rp "Супер админы утас (8 орон): " ADMIN_PHONE
read -rp "Супер админы нэр: " ADMIN_NAME
read -rsp "Супер админы нууц үг (6+ тэмдэгт): " ADMIN_PASSWORD; echo

PG_PASS=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
if [ -n "$DOMAIN" ]; then COOKIE_SECURE=true; APP_URL="https://$DOMAIN"; else DOMAIN=":80"; COOKIE_SECURE=false; APP_URL="http://$(hostname -I | awk '{print $1}')"; fi

umask 077
cat > .env <<ENV
POSTGRES_PASSWORD=$PG_PASS
DOMAIN=$DOMAIN
COOKIE_SECURE=$COOKIE_SECURE
APP_URL=$APP_URL
ENV
mkdir -p backups

say "Бүтээж, эхлүүлж байна (5-10 минут)"
docker compose up -d --build

say "Апп бэлэн болохыг хүлээж байна"
for i in $(seq 1 60); do
  if docker compose exec -T app node healthcheck.mjs >/dev/null 2>&1; then break; fi
  sleep 3
done

say "Супер админ үүсгэж байна"
docker compose exec -T -e ADMIN_PHONE="$ADMIN_PHONE" -e ADMIN_NAME="$ADMIN_NAME" -e ADMIN_PASSWORD="$ADMIN_PASSWORD" app node scripts/create-super-admin.mjs

say "Анхны backup"
docker compose run --rm -e BACKUP_NOW=1 backup >/dev/null && ls -1 backups | tail -1

say "Бэлэн! Нээх хаяг: $APP_URL"
