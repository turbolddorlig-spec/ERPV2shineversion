-- #119 Бараа татах (нөөц хоног) — зөвхөн Супер админ
CREATE TABLE "ReorderOrder" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "expectedDay" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "orderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byName" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    CONSTRAINT "ReorderOrder_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReorderOrder_productId_orderedAt_idx" ON "ReorderOrder"("productId", "orderedAt");
-- Нэг бараанд нэг л идэвхтэй (ирээгүй, цуцлаагүй) захиалга
CREATE UNIQUE INDEX "ReorderOrder_active_key" ON "ReorderOrder"("productId") WHERE "receivedAt" IS NULL AND "cancelledAt" IS NULL;
