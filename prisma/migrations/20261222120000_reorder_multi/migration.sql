-- #205 (эзний шийдвэр): нэг барааг (өнгийг) хэд хэдэн удаа «Захиалсан» болгож болно (дахин татах) — нэг нээлттэй захиалгын хязгаарыг авна.
-- Зөвхөн бүтэц: өгөгдөлд хүрэхгүй. Хайлтад энгийн (unique биш) индекс.
DROP INDEX IF EXISTS "ReorderOrder_active_key";
CREATE INDEX IF NOT EXISTS "ReorderOrder_active_idx" ON "ReorderOrder"("productId", "scope", COALESCE("variantId", 0)) WHERE "receivedAt" IS NULL AND "cancelledAt" IS NULL;
