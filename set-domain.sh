#!/usr/bin/env bash
# Домэйн авсны дараа HTTP (IP) → HTTPS (домэйн) руу шилжүүлнэ.
# Хэрэглээ: ./set-domain.sh v2.erpzahialga.com
# Буцаад IP (HTTP) горимд: ./set-domain.sh --ip 103.153.141.29
# Өмнө нь: домэйны DNS (A record) энэ серверийн IP руу заасан байх, 80 ба 443 порт нээлттэй байх.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo ".env алга — эхлээд ./install.sh ажиллуулна уу"; exit 1; }
D=$(echo "${1:-}" | tr -d '[:space:]' | sed -e 's#^https\?://##' -e 's#/.*$##')
[ -n "$D" ] || { echo "Хэрэглээ: ./set-domain.sh v2.erpzahialga.com   (эсвэл ./set-domain.sh --ip <IP>)"; exit 1; }

cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
set_kv() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }

if [ "$D" = "--ip" ]; then
  IP=$(echo "${2:-}" | tr -d '[:space:]')
  [ -n "$IP" ] || { echo "Хэрэглээ: ./set-domain.sh --ip 103.153.141.29"; exit 1; }
  set_kv DOMAIN ""
  set_kv COOKIE_SECURE false
  set_kv APP_URL "http://$IP"
  docker compose up -d app caddy
  echo "IP (HTTP) горимд шилжлээ: http://$IP"
  exit 0
fi

set_kv DOMAIN "$D"
set_kv COOKIE_SECURE true
set_kv APP_URL "https://$D"

docker compose up -d app caddy
echo "Шилжлээ. Хэдэн секундийн дараа нээх хаяг: https://$D"
echo "Хуучин IP хаягаар нэвтэрсэн хүмүүс домэйн хаягаар дахин нэвтэрнэ."
