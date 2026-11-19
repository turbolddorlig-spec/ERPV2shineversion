#!/usr/bin/env bash
# Шинэ Супер админ нэмэх, эсвэл нэвтэрч чадахгүй болсон Супер админы нууц үгийг сэргээх (сервер дээр).
# Утас бүртгэлтэй бол: нэр, нууц үг шинэчлэгдэж, Супер админ болж, түгжээ тайлагдана. Үгүй бол шинээр үүснэ.
set -euo pipefail
cd "$(dirname "$0")"
read -rp "Утасны дугаар (8 орон): " PHONE
read -rp "Нэр: " NAME
read -rsp "Нууц үг (6+ тэмдэгт, бичихэд харагдахгүй): " PW; echo
read -rsp "Нууц үг дахин: " PW2; echo
[ "$PW" = "$PW2" ] || { echo "Нууц үг таарсангүй — дахин оролдоно уу"; exit 1; }
docker compose exec -T -e ADD=1 -e ADMIN_PHONE="$PHONE" -e ADMIN_NAME="$NAME" -e ADMIN_PASSWORD="$PW" app node scripts/create-super-admin.mjs
