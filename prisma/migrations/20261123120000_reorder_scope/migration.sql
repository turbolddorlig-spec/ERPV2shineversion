-- #124-Ж: таны ба нийлүүлэгчийн «Захиалсан» тэмдэг тусдаа
ALTER TABLE "ReorderOrder" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'OWNER';
DROP INDEX IF EXISTS "ReorderOrder_active_key";
CREATE UNIQUE INDEX "ReorderOrder_active_key" ON "ReorderOrder"("productId", "scope") WHERE "receivedAt" IS NULL AND "cancelledAt" IS NULL;
