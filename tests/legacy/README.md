# #182 Хуучин ERP шилжүүлэлтийн тест (гараар)

Бодит өгөгдөл ХЭЗЭЭ Ч энд орохгүй — зөвхөн хуурамч.

1. Хуучин ERP-ийн бүтэцтэй хоосон DB: `DATABASE_URL=…/erp_legacy_test npx prisma db push --schema <хуучин repo>/prisma/schema.prisma --skip-generate`
2. Хуурамч өгөгдөл: `psql …/erp_legacy_test -f tests/legacy/seed-legacy.sql`
3. Зорилтот DB (V2 бүтэц, `scripts/sql/reset-data.sql`-ээр цэвэрлэсэн) руу:
   `npx esbuild scripts/legacy/migrate.ts --bundle --platform=node --format=esm --outfile=dist/legacy-migrate.mjs --external:@prisma/client --external:sharp --external:bcryptjs --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"`
   `DATABASE_URL=…/erp_v2_migtest node dist/legacy-migrate.mjs --legacy …/erp_legacy_test --skip-from 2026-11-18 --skip-to 2026-11-20`
4. Шалгах: тайлангийн `reconcile` (захиалгын тоо/дүн), дахин ажиллуулахад `created: 0` (давхардахгүй).

Сервер дээрх бүтэн урсгал: `./legacy-migrate.sh analyze | trial | real | cleanup` (2026-11-19-нд Docker-оор эхнээс дуустал туршсан).
