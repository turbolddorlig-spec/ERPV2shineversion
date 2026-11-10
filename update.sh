#!/usr/bin/env bash
# zahialga• ERP V2 — шинэчлэх (шинэ хувилбар гарах бүрт)
# 1) backup  2) шинэ код татах  3) бүтээх  4) migration автоматаар  5) шалгах
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1;33m▶ %s\033[0m\n' "$1"; }
[ -f .env ] || { echo ".env алга — эхлээд ./install.sh ажиллуулна уу"; exit 1; }

say "Шинэчлэхийн өмнөх backup"
docker compose run --rm -e BACKUP_NOW=1 backup >/dev/null
ls -1t backups | head -1

PREV=$(git rev-parse --short HEAD)
say "Шинэ код татаж байна (одоогийн: $PREV)"
git pull --ff-only

say "Бүтээж, дахин эхлүүлж байна"
docker compose up -d --build

say "Шалгаж байна"
ok=0
for i in $(seq 1 60); do
  if docker compose exec -T app node healthcheck.mjs >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
if [ "$ok" = 1 ]; then
  say "Амжилттай: $(git rev-parse --short HEAD)"
else
  echo "АЛДАА: апп эхэлсэнгүй. Логийг харах: docker compose logs --tail=100 app"
  echo "Өмнөх хувилбар руу буцах: git checkout $PREV && docker compose up -d --build"
  exit 1
fi
