-- #79: жолоочийн хувийн «Өрийн дэвтэр» (шинэ хүснэгт; хуучин өгөгдөлд өөрчлөлтгүй)
CREATE TABLE "DriverDebt" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "driverId" UUID NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    CONSTRAINT "DriverDebt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DriverDebt_driverId_paidAt_idx" ON "DriverDebt"("driverId", "paidAt");
CREATE INDEX "DriverDebt_orderId_idx" ON "DriverDebt"("orderId");
-- Нэг захиалгад идэвхтэй (төлөөгүй, цуцлаагүй) нэг л мөр
CREATE UNIQUE INDEX "DriverDebt_active_order" ON "DriverDebt"("orderId") WHERE "paidAt" IS NULL AND "cancelledAt" IS NULL;
-- Өмнө нь «Төлөөгүй» гэж хүргэсэн захиалгуудыг дэвтэрт оруулна (зөвхөн нэмнэ)
INSERT INTO "DriverDebt" ("orderId", "driverId", "orderNumber", "phone", "amount", "createdAt")
SELECT id, "driverId", number, phone, total, COALESCE("deliveredAt", now()) FROM "Order"
WHERE status = 'DELIVERED' AND "deliveryPayment" = 'UNPAID' AND "driverId" IS NOT NULL;
