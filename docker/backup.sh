#!/bin/sh
# zahialga• ERP V2 — нөөц хуулбар (аудит №2, #132)
#  - Өдөр бүр 03:00 (Улаанбаатар): database-ийн бүрэн хуулбар → /backups/daily (14), сар бүрийн → /backups/monthly (12)
#  - Хуулбар бүрийг шалгана: pg_dump алдаагүй, gzip бүтэн, хэмжээ > 10KB, төгсгөлийн тэмдэг байгаа. Эвдэрсэн бол хадгалахгүй.
#  - Хуучныг ЗӨВХӨН амжилттай хуулбарын дараа, ТООГООР нь устгана (бүтэлгүйтэл хэзээ ч сайн хуулбарыг устгахгүй).
#  - Google Drive холбогдсон бол (./setup-drive-backup.sh): daily 7, weekly 4, monthly 12 (Drive-ийн хогийн саванд хийхгүй, шууд устгана).
#  - Барааны зураг: зөвхөн серверийн /backups/media (эзний шийдвэр — Drive-д хуулахгүй).
#  - Төлөв /backups/.status/status.json → апп Супер админд анхааруулна (26 цаг хуулбаргүй, Drive алдаа, 80%+ дүүрсэн).
#  BACKUP_NOW=1 — одоо нэг удаа (daily); BACKUP_NOW=update — шинэчлэлтийн өмнөх (/backups/update, 5)
set -eu
set -o pipefail
B=/backups
S=$B/.status
mkdir -p "$B/daily" "$B/monthly" "$B/update" "$B/media" "$S"
export RCLONE_CONFIG="$B/.rclone/rclone.conf"
REMOTE="${DRIVE_REMOTE:-gdrive:zahialga-backup}"
RC="--drive-use-trash=false --retries 3 --low-level-retries 5"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
put() { printf '%s' "$2" > "$S/.$1"; }
get() { cat "$S/.$1" 2>/dev/null || true; }
esc() { printf '%s' "$1" | tr -d '\r' | tr '\n"\\' '   ' | cut -c1-300; }
write_status() {
  drive=false; [ -f "$RCLONE_CONFIG" ] && drive=true
  cat > "$S/status.json.tmp" <<J
{"lastOk":"$(get lastOk)","lastFile":"$(get lastFile)","lastBytes":"$(get lastBytes)","lastErrorAt":"$(get lastErrorAt)","lastError":"$(esc "$(get lastError)")","warning":"$(esc "$(get warning)")","driveConfigured":$drive,"driveOkAt":"$(get driveOkAt)","driveErrorAt":"$(get driveErrorAt)","driveError":"$(esc "$(get driveError)")","driveUsedPct":"$(get driveUsedPct)","checkedAt":"$(ts)"}
J
  mv "$S/status.json.tmp" "$S/status.json"
}
fail() { echo "[backup] АЛДАА: $1" >&2; put lastErrorAt "$(ts)"; put lastError "$1"; write_status; return 1; }

# Хуучин бүтэц (/backups/erp-*.sql.gz) → daily/
for f in "$B"/erp-*.sql.gz; do [ -e "$f" ] && mv "$f" "$B/daily/"; done

# Хамгийн шинэ N-ээс бусдыг устгана (нэрээр эрэмбэлсэн — нэрэнд огноо бий)
prune_local() { ls -1 "$1"/erp-*.sql.gz 2>/dev/null | sort -r | tail -n +"$(($2 + 1))" | xargs -r rm -f; }
prune_remote() {
  rclone lsf $RC --files-only "$REMOTE/$1" 2>/dev/null | grep '^erp-.*\.sql\.gz$' | sort -r | tail -n +"$(($2 + 1))" | while read -r x; do
    rclone deletefile $RC "$REMOTE/$1/$x"
  done
}

dump() { # $1 = эцсийн файл
  f="$1"; tmp="$f.tmp"
  rm -f "$tmp"
  if ! pg_dump -h db -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner | gzip > "$tmp"; then rm -f "$tmp"; fail "pg_dump амжилтгүй (database холбогдсонгүй?)"; return 1; fi
  if ! gzip -t "$tmp" 2>/dev/null; then rm -f "$tmp"; fail "gzip файл эвдэрсэн"; return 1; fi
  size=$(wc -c < "$tmp")
  if [ "$size" -lt 10240 ]; then rm -f "$tmp"; fail "хуулбар хэт жижиг ($size байт)"; return 1; fi
  if ! gunzip -c "$tmp" | tail -c 400 | grep -q "PostgreSQL database dump complete"; then rm -f "$tmp"; fail "хуулбар дутуу (төгсгөл алга)"; return 1; fi
  prev=$(get lastBytes)
  if [ -n "$prev" ] && [ "$size" -lt $((prev / 2)) ]; then put warning "Хуулбарын хэмжээ огцом багассан: $prev → $size байт ($(ts))"; else put warning ""; fi
  mv "$tmp" "$f"
  put lastOk "$(ts)"; put lastFile "$(basename "$f")"; put lastBytes "$size"
  echo "[backup] OK $(basename "$f") $size байт"
}

drive_ops() { # $1 = файл, $2 = төрөл — алхам бүр алдаа гарвал зогсоно
  f="$1"; n=$(basename "$f")
  rclone copyto $RC "$f" "$REMOTE/$2/$n" || return 1
  if [ "$2" = daily ]; then
    wk="erp-$(date +%G-W%V).sql.gz"
    if ! rclone lsf $RC --files-only "$REMOTE/weekly" 2>/dev/null | grep -qx "$wk"; then rclone copyto $RC "$f" "$REMOTE/weekly/$wk" || return 1; fi
    mo="erp-$(date +%Y%m).sql.gz"
    if ! rclone lsf $RC --files-only "$REMOTE/monthly" 2>/dev/null | grep -qx "$mo"; then rclone copyto $RC "$f" "$REMOTE/monthly/$mo" || return 1; fi
    prune_remote daily 7; prune_remote weekly 4; prune_remote monthly 12
  else
    prune_remote update 3
  fi
}
to_drive() { # $1 = файл, $2 = төрөл (daily|update)
  [ -f "$RCLONE_CONFIG" ] || { write_status; return 0; }
  if ! out=$(drive_ops "$1" "$2" 2>&1); then
    put driveErrorAt "$(ts)"; put driveError "$(echo "$out" | tail -n 3)"; echo "[backup] Drive АЛДАА: $out" >&2; write_status; return 0
  fi
  put driveOkAt "$(ts)"; put driveError ""
  # Дүүргэлт: 80%+ бол анхааруулга; 90%+ бол хамгийн хуучин сарын хуулбарыг устгана
  about=$(rclone about $RC --json "$REMOTE" 2>/dev/null || true)
  pct=$(echo "$about" | tr -d ' \n' | sed -n 's/.*"total":\([0-9]*\).*"used":\([0-9]*\).*/\1 \2/p' | awk '$1>0{printf "%d", $2*100/$1}')
  if [ -z "$pct" ]; then pct=$(echo "$about" | tr -d ' \n' | sed -n 's/.*"used":\([0-9]*\).*"total":\([0-9]*\).*/\2 \1/p' | awk '$1>0{printf "%d", $2*100/$1}'); fi
  put driveUsedPct "${pct:-}"
  if [ -n "${pct:-}" ] && [ "$pct" -ge 90 ]; then
    old=$(rclone lsf $RC --files-only "$REMOTE/monthly" 2>/dev/null | sort | head -n 1)
    [ -n "$old" ] && rclone deletefile $RC "$REMOTE/monthly/$old" && echo "[backup] Drive 90%+ — хамгийн хуучин сарын хуулбар устгав: $old"
  fi
  write_status
}

media() {
  # Зөвхөн шинэ файлыг хуулна (зураг өөрчлөгддөггүй — UUID нэр)
  if [ -d /uploads/products ]; then
    (cd /uploads && find products -type f) | while read -r f; do
      if [ ! -e "$B/media/$f" ]; then mkdir -p "$B/media/$(dirname "$f")" && cp -p "/uploads/$f" "$B/media/$f"; fi
    done
  fi
  echo "[backup] зураг: $(find "$B/media" -type f | wc -l) файл"
}

run_daily() {
  f="$B/daily/erp-$(date +%Y%m%d-%H%M).sql.gz"
  dump "$f" || return 1
  prune_local "$B/daily" 14
  mo="$B/monthly/erp-$(date +%Y%m).sql.gz"
  [ -e "$mo" ] || cp -p "$f" "$mo"
  prune_local "$B/monthly" 12
  media || true
  write_status
  to_drive "$f" daily
}
run_update() {
  f="$B/update/erp-$(date +%Y%m%d-%H%M%S)-update.sql.gz"
  dump "$f" || return 1
  prune_local "$B/update" 5
  write_status
  to_drive "$f" update
  echo "$f"
}

case "${BACKUP_NOW:-}" in
  update) run_update; exit $? ;;
  ?*) run_daily; exit $? ;;
esac
write_status
while true; do
  if [ "$(date +%H%M)" = "0300" ]; then run_daily || true; sleep 61; fi
  sleep 30
done
