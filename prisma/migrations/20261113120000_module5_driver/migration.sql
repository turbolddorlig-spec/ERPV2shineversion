-- CreateEnum
CREATE TYPE "DeliveryPayment" AS ENUM ('CASH', 'BANK', 'UNPAID', 'PREPAID');

-- CreateEnum
CREATE TYPE "IssueType" AS ENUM ('WRONG_PRODUCT', 'WRONG_NUMBER', 'UNCLEAR_ADDRESS');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('PENDING', 'FIXED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IssueFault" AS ENUM ('OPERATOR', 'DRIVER', 'MARKETING', 'WAREHOUSE');

-- CreateEnum
CREATE TYPE "DriverDocKind" AS ENUM ('RETURN', 'EXTRA_TAKE', 'EXTRA_SALE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CancelReason" ADD VALUE 'DRIVER_CANCELLED';
ALTER TYPE "CancelReason" ADD VALUE 'ISSUE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MoveType" ADD VALUE 'DELIVERY';
ALTER TYPE "MoveType" ADD VALUE 'DELIVERY_BACK';
ALTER TYPE "MoveType" ADD VALUE 'DRIVER_RETURN';
ALTER TYPE "MoveType" ADD VALUE 'EXTRA_OUT';
ALTER TYPE "MoveType" ADD VALUE 'EXTRA_SALE';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "collectAmount" INTEGER,
ADD COLUMN     "deliveredByName" TEXT,
ADD COLUMN     "deliveryNote" TEXT,
ADD COLUMN     "deliveryPayment" "DeliveryPayment",
ADD COLUMN     "issueAt" TIMESTAMP(3),
ADD COLUMN     "issueFault" "IssueFault",
ADD COLUMN     "issueNote" TEXT,
ADD COLUMN     "issueResolveNote" TEXT,
ADD COLUMN     "issueResolvedAt" TIMESTAMP(3),
ADD COLUMN     "issueResolvedByName" TEXT,
ADD COLUMN     "issueStatus" "IssueStatus",
ADD COLUMN     "issueType" "IssueType",
ADD COLUMN     "originalTotal" INTEGER,
ADD COLUMN     "postponedAt" TIMESTAMP(3),
ADD COLUMN     "postponedByDriverId" UUID,
ADD COLUMN     "postponedByName" TEXT,
ADD COLUMN     "routeNo" INTEGER;

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN     "refusedQty" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "DriverDoc" (
    "id" SERIAL NOT NULL,
    "kind" "DriverDocKind" NOT NULL,
    "driverId" UUID NOT NULL,
    "driverName" TEXT NOT NULL,
    "byId" UUID NOT NULL,
    "byName" TEXT NOT NULL,
    "note" TEXT,
    "payment" "DeliveryPayment",
    "total" INTEGER NOT NULL DEFAULT 0,
    "idemKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverDocLine" (
    "id" SERIAL NOT NULL,
    "docId" INTEGER NOT NULL,
    "variantId" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "expected" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DriverDocLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriverDoc_idemKey_key" ON "DriverDoc"("idemKey");

-- CreateIndex
CREATE INDEX "DriverDoc_driverId_createdAt_idx" ON "DriverDoc"("driverId", "createdAt");

-- CreateIndex
CREATE INDEX "DriverDoc_kind_createdAt_idx" ON "DriverDoc"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "DriverDocLine_docId_idx" ON "DriverDocLine"("docId");

-- CreateIndex
CREATE INDEX "DriverDocLine_variantId_idx" ON "DriverDocLine"("variantId");

-- CreateIndex
CREATE INDEX "Order_driverId_deliveredAt_idx" ON "Order"("driverId", "deliveredAt");

-- CreateIndex
CREATE INDEX "Order_driverId_cancelledAt_idx" ON "Order"("driverId", "cancelledAt");

-- CreateIndex
CREATE INDEX "Order_postponedByDriverId_postponedAt_idx" ON "Order"("postponedByDriverId", "postponedAt");

-- CreateIndex
CREATE INDEX "Order_issueStatus_issueAt_idx" ON "Order"("issueStatus", "issueAt");

-- AddForeignKey
ALTER TABLE "DriverDocLine" ADD CONSTRAINT "DriverDocLine_docId_fkey" FOREIGN KEY ("docId") REFERENCES "DriverDoc"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Модуль 5: хэсэгчилсэн хүргэлтийн тоо 0..qty
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_refused_check" CHECK ("refusedQty" >= 0 AND "refusedQty" <= "qty");
-- Жолоочийн баримтын мөр эерэг
ALTER TABLE "DriverDocLine" ADD CONSTRAINT "DriverDocLine_qty_check" CHECK ("qty" > 0 AND "expected" >= 0 AND "unitPrice" >= 0);
