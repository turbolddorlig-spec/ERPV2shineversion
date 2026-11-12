#!/usr/bin/env bash
# zahialga• ERP V2 — нөөц хуулбарыг Google Drive-д холбох (нэг удаа) (#132)
# Санал: зөвхөн хуулбарт зориулсан ТУСДАА Google бүртгэл (жишээ zahialga.backup@gmail.com) — 15GB бүхэлдээ хуулбарт.
set -euo pipefail
cd "$(dirname "$0")"
say() { printf '\n\033[1;33m▶ %s\033[0m\n' "$1"; }
# docker compose run нь stdin-ийг (бичсэн хариултыг) идэхгүй байх ёстой
dcr() { docker compose run --rm -T "$@" </dev/null; }
die() { printf '\n\033[1;31mАЛДАА: %s\033[0m\n' "$1"; exit 1; }
[ -f .env ] || die ".env алга — эхлээд ./install.sh"
REMOTE=$(grep -E '^DRIVE_REMOTE=' .env | cut -d= -f2- || true); REMOTE=${REMOTE:-gdrive:zahialga-backup}

say "Хуулбарын контейнерийг бэлдэж байна"
docker compose build backup >/dev/null
mkdir -p backups/.rclone && chmod 700 backups/.rclone

cat <<'TXT'

Google бүртгэлээр «Зөвшөөрөх» хоёр аргын нэгийг сонгоно:

  1) Энэ серверт өөрийн компьютерээсээ ингэж холбогдсон бол (санал болгох):
        ssh -L 53682:127.0.0.1:53682 root@СЕРВЕРИЙН-IP
     Доор гарах http://127.0.0.1:53682/... холбоосыг компьютерийнхоо браузерт нээж,
     хуулбарын Google бүртгэлээр нэвтэрч «Allow / Зөвшөөрөх» дарна.

  2) Компьютер дээрээ rclone (https://rclone.org/downloads/) татаад
        rclone authorize "drive"
     гэж ажиллуулж, браузерт зөвшөөрсний дараа гарсан {"access_token":...} мөрийг энд хуулна.

TXT
read -rp "Арга (1 эсвэл 2): " m
TOKEN=""
if [ "$m" = 1 ]; then
  say "Доорх холбоосыг браузерт нээнэ үү (хүлээж байна...)"
  OUT=$(docker run --rm -i --network host --entrypoint rclone zahialga-backup:local authorize drive --auth-no-open-browser 2>&1 | tee /dev/stderr) || true
  TOKEN=$(printf '%s\n' "$OUT" | grep -o '{"access_token".*}' | tail -n 1)
elif [ "$m" = 2 ]; then
  read -rp "Token мөрийг хуулна уу: " TOKEN
else
  die "1 эсвэл 2"
fi
printf '%s' "$TOKEN" | grep -q '"refresh_token"' || die "Token олдсонгүй — дахин оролдоно уу"

umask 077
cat > backups/.rclone/rclone.conf <<CONF
[gdrive]
type = drive
scope = drive
token = $TOKEN
CONF

say "Шалгаж байна"
dcr --entrypoint sh backup -c "export RCLONE_CONFIG=/backups/.rclone/rclone.conf; rclone mkdir '$REMOTE' && rclone about '$REMOTE'" || die "Drive-д холбогдсонгүй — дахин оролдоно уу"

say "Одоо нэг хуулбар авч Drive руу хуулж байна"
dcr -e BACKUP_NOW=1 backup
docker compose up -d backup >/dev/null
grep -o '"driveOkAt":"[^"]*"' backups/.status/status.json || true
say "Бэлэн. Өдөр бүр 03:00-д Drive-ийн «zahialga-backup» хавтас руу хуулна (7 өдөр, 4 долоо хоног, 12 сар)."
