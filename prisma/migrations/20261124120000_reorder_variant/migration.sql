-- #128 Бараа татах — өнгө / хэмжээ тус бүрээр «Захиалсан»
ALTER TABLE "ReorderOrder" ADD COLUMN "variantId" INTEGER;
DROP INDEX IF EXISTS "ReorderOrder_active_key";
CREATE UNIQUE INDEX "ReorderOrder_active_key" ON "ReorderOrder"("productId", "scope", COALESCE("variantId", 0)) WHERE "receivedAt" IS NULL AND "cancelledAt" IS NULL;
