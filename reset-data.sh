#!/usr/bin/env bash
# zahialga• ERP V2 — ТУРШИЛТЫН өгөгдлийг цэвэрлэх (бодит өгөгдөл оруулахын өмнө, НЭГ удаа)
# ҮЛДЭНЭ: Супер админ хэрэглэгч, Тохиргоо (SMS, Meta, хүргэлтийн төлбөр, Drive …), цалингийн дүрэм.
# УСТАНА: бараа, агуулах, үлдэгдэл, захиалга, падаан, тооцоо, өр, цалин, нийлүүлэгч, түүх, бусад бүх хэрэглэгч, барааны зураг.
# Өмнө нь автоматаар backup авна (амжилтгүй бол юу ч устгахгүй). Буцаах: ./restore.sh <backup файл>
set -euo pipefail
cd "$(dirname "$0")"
say() { printf '\n\033[1;33m▶ %s\033[0m\n' "$1"; }
[ -f .env ] || { echo ".env алга — энэ скриптийг ERP-ийн хавтсанд ажиллуулна уу"; exit 1; }

printf '\n\033[1;31m⚠ АНХААР: шинэ ERP-ийн БҮХ өгөгдөл устна (Супер админ, тохиргоо л үлдэнэ).\033[0m\n'
echo "Хаяг: $(grep -E '^APP_URL=' .env | cut -d= -f2-)"
docker compose exec -T db psql -U erp -d erp -tAc 'SELECT '"'"'Одоо: '"'"' || (SELECT count(*) FROM "Order") || '"'"' захиалга, '"'"' || (SELECT count(*) FROM "Product") || '"'"' бараа, '"'"' || (SELECT count(*) FROM "User") || '"'"' хэрэглэгч'"'"''
read -rp "Үргэлжлүүлэх бол том үсгээр УСТГА гэж бичнэ үү: " ANS
[ "$ANS" = "УСТГА" ] || { echo "Цуцаллаа — юу ч өөрчлөгдсөнгүй."; exit 1; }

say "Устгахын өмнөх backup (шалгалттай)"
docker compose build backup >/dev/null
BK=$(docker compose run --rm -T -e BACKUP_NOW=update backup </dev/null | tail -n 1) || { echo "АЛДАА: backup авч чадсангүй — юу ч устгасангүй"; exit 1; }
echo "$BK"

say "Апп-ыг түр зогсоож байна (энэ хооронд хэн ч өгөгдөл оруулахгүй)"
docker compose stop app

say "Өгөгдөл цэвэрлэж байна"
if ! docker compose exec -T db psql -U erp -d erp -v ON_ERROR_STOP=1 < scripts/sql/reset-data.sql; then
  echo "АЛДАА: цэвэрлэгээ бүтсэнгүй — өөрчлөлт буцаагдсан (өгөгдөл хэвээр). Апп-ыг дахин асааж байна."
  docker compose start app; exit 1
fi

say "Туршилтын барааны зургийг устгаж байна"
docker compose run --rm -T --no-deps --entrypoint sh app -c 'rm -rf /app/data/uploads/products && echo "зураг цэвэрлэгдлээ"' || echo "(зураг цэвэрлэж чадсангүй — системд нөлөөгүй)"

say "Апп-ыг асааж байна"
docker compose start app
ok=0
for i in $(seq 1 60); do
  if docker compose exec -T app node healthcheck.mjs >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
[ "$ok" = 1 ] && say "Дууслаа ✓ Супер админаар дахин нэвтэрнэ үү." || echo "АЛДАА: апп эхэлсэнгүй — docker compose logs --tail=100 app"
echo "Хэрэв буцаах шаардлага гарвал: ./restore.sh backups/${BK#/backups/}"
