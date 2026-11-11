-- Модуль 7а (#90): торгууль, падаан бэлдсэн ажилтан
-- CreateEnum
CREATE TYPE "PenaltyType" AS ENUM ('OPP_ERROR', 'DELIVERY_ERROR', 'MARKETING_ERROR', 'WAREHOUSE_ERROR');

-- AlterTable
ALTER TABLE "Handover" ADD COLUMN     "preparedById" UUID;

-- CreateTable
CREATE TABLE "Penalty" (
    "id" SERIAL NOT NULL,
    "type" "PenaltyType" NOT NULL,
    "category" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "description" TEXT,
    "userId" UUID NOT NULL,
    "userName" TEXT NOT NULL,
    "orderId" INTEGER,
    "orderNumber" TEXT,
    "pageName" TEXT,
    "customerPhone" TEXT,
    "customerName" TEXT,
    "lateMinutes" INTEGER,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "cancelledAt" TIMESTAMP(3),
    "cancelledByName" TEXT,
    "cancelNote" TEXT,
    "deducted" BOOLEAN NOT NULL DEFAULT false,
    "deductedAt" TIMESTAMP(3),
    "deductedByName" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Penalty_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Penalty_userId_createdAt_idx" ON "Penalty"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Penalty_createdAt_idx" ON "Penalty"("createdAt");

-- CreateIndex
CREATE INDEX "Penalty_type_createdAt_idx" ON "Penalty"("type", "createdAt");

-- CreateIndex
CREATE INDEX "Penalty_orderId_idx" ON "Penalty"("orderId");


-- Автомат торгууль: нэг захиалгад нэг төрөл нэг л удаа (идэвхтэй)
CREATE UNIQUE INDEX "Penalty_auto_order_type" ON "Penalty"("orderId", "type") WHERE "auto" = true AND "status" = 'ACTIVE';
