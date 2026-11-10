-- CreateEnum
CREATE TYPE "HandoverStatus" AS ENUM ('DRAFT', 'PREPARED', 'HANDED_OVER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MoveType" ADD VALUE 'HANDOVER';
ALTER TYPE "MoveType" ADD VALUE 'HANDOVER_BACK';












-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "driverId" UUID,
ADD COLUMN     "driverName" TEXT,
ADD COLUMN     "outForDeliveryAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Handover" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "driverId" UUID NOT NULL,
    "driverName" TEXT NOT NULL,
    "warehouseId" INTEGER NOT NULL,
    "status" "HandoverStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID NOT NULL,
    "createdByName" TEXT NOT NULL,
    "preparedAt" TIMESTAMP(3),
    "preparedBy" TEXT,
    "handedOverAt" TIMESTAMP(3),
    "handedOverBy" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Handover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandoverOrder" (
    "id" SERIAL NOT NULL,
    "handoverId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removeReason" TEXT,

    CONSTRAINT "HandoverOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandoverCheck" (
    "handoverId" INTEGER NOT NULL,
    "variantId" INTEGER NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedBy" TEXT NOT NULL,

    CONSTRAINT "HandoverCheck_pkey" PRIMARY KEY ("handoverId","variantId")
);

-- CreateTable
CREATE TABLE "DriverApproval" (
    "driverId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "approved" BOOLEAN NOT NULL,
    "note" TEXT,
    "byName" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverApproval_pkey" PRIMARY KEY ("driverId","date")
);

-- CreateTable
CREATE TABLE "DriverSetting" (
    "userId" UUID NOT NULL,
    "trusted" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "DriverSetting_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Handover_number_key" ON "Handover"("number");

-- CreateIndex
CREATE INDEX "Handover_date_idx" ON "Handover"("date");

-- CreateIndex
CREATE INDEX "Handover_status_date_idx" ON "Handover"("status", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Handover_driverId_date_key" ON "Handover"("driverId", "date");

-- CreateIndex
CREATE INDEX "HandoverOrder_orderId_idx" ON "HandoverOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "HandoverOrder_handoverId_orderId_key" ON "HandoverOrder"("handoverId", "orderId");

-- CreateIndex
CREATE INDEX "Order_driverId_deliveryDate_idx" ON "Order"("driverId", "deliveryDate");

-- AddForeignKey
ALTER TABLE "HandoverOrder" ADD CONSTRAINT "HandoverOrder_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "Handover"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoverCheck" ADD CONSTRAINT "HandoverCheck_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "Handover"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ───── Модуль 4: гараар нэмсэн хамгаалалт ─────
CREATE SEQUENCE IF NOT EXISTS handover_number_seq START 1;
-- Нэг захиалга зөвхөн НЭГ идэвхтэй падаанд (хасагдсан мөр түүхэнд үлдэнэ)
CREATE UNIQUE INDEX "HandoverOrder_active_order" ON "HandoverOrder" ("orderId") WHERE "removedAt" IS NULL;
ALTER TABLE "HandoverOrder" ADD CONSTRAINT "HandoverOrder_position_check" CHECK ("position" > 0);
-- Жолоочид оноосон / хүргэлтэд гарсан захиалга заавал жолоочтой
ALTER TABLE "Order" ADD CONSTRAINT "Order_driver_check" CHECK (status NOT IN ('ASSIGNED', 'OUT_FOR_DELIVERY') OR "driverId" IS NOT NULL) NOT VALID;
