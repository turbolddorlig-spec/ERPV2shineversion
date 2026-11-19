-- Шинэ ERP-ийн ТУРШИЛТЫН өгөгдлийг цэвэрлэнэ (эзний шийдвэр, 2026-11-19).
-- ҮЛДЭНЭ: Супер админ хэрэглэгч(ид), Тохиргоо (AppSetting), цалингийн дүрэм (SalaryRule), migration-ийн бүртгэл.
-- УСТАНА: бусад бүх хүснэгт (бараа, агуулах, захиалга, падаан, тооцоо, өр, цалин, нийлүүлэгч, түүх, нэвтрэлт…) + Супер админ биш хэрэглэгчид.
\set ON_ERROR_STOP on
BEGIN;
ALTER TABLE "AuditLog" DISABLE TRIGGER USER;
ALTER TABLE "StockMove" DISABLE TRIGGER USER;
DO $$
DECLARE t text;
BEGIN
  SELECT string_agg(format('%I', tablename), ', ') INTO t FROM pg_tables
   WHERE schemaname = 'public' AND tablename NOT IN ('User', 'AppSetting', 'SalaryRule', '_prisma_migrations');
  EXECUTE 'TRUNCATE ' || t || ' RESTART IDENTITY CASCADE';
END $$;
DELETE FROM "User" WHERE NOT ('SUPER_ADMIN' = ANY("roles"));
-- «Замдаа» байршил (migration-ийн адил)
INSERT INTO "StockLocation" ("kind", "name") VALUES ('TRANSIT', 'Замдаа');
ALTER SEQUENCE order_number_seq RESTART WITH 1;
ALTER SEQUENCE handover_number_seq RESTART WITH 1;
-- Өдрийн эцсийн автомат ажлуудын тэмдэг (тест өгөгдлийн үеийнх) — дахин эхэлнэ
DELETE FROM "AppSetting" WHERE key IN ('m6.shortageClosedFor', 'm6.shortageSkipped');
ALTER TABLE "StockMove" ENABLE TRIGGER USER;
ALTER TABLE "AuditLog" ENABLE TRIGGER USER;
INSERT INTO "AuditLog" ("actorName", "action", "entityType", "details", "tags")
VALUES ('СИСТЕМ (reset-data.sh)', 'system.data_reset', 'System', '{"note":"Туршилтын өгөгдөл цэвэрлэгдсэн — зөвхөн Супер админ, тохиргоо үлдсэн"}', ARRAY['system']);
COMMIT;
SELECT (SELECT count(*) FROM "User") AS "үлдсэн_хэрэглэгч", (SELECT count(*) FROM "Order") AS "захиалга", (SELECT count(*) FROM "Product") AS "бараа", (SELECT count(*) FROM "AppSetting") AS "тохиргоо";
