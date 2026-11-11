-- Модуль 6 (Нягтлан, #82, #83): өдрийн тооцоо (падааны өдөр), цалингийн дүрэм, жолоочийн горим, компанийн өр, урьдчилгаа/нэмэлт барааны тооцоо, банкны гүйлгээ
-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'PENDING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "CompanyDebtKind" AS ENUM ('GOODS_NOT_RETURNED', 'PRODUCT_NOT_DELIVERED', 'ACCOUNTING_MISMATCH', 'SETTLEMENT_DEBT', 'OTHER');

-- CreateTable
CREATE TABLE "DriverSettlement" (
    "id" SERIAL NOT NULL,
    "driverId" UUID NOT NULL,
    "driverName" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "cashAmount" INTEGER NOT NULL DEFAULT 0,
    "bankAmount" INTEGER NOT NULL DEFAULT 0,
    "debtAmount" INTEGER NOT NULL DEFAULT 0,
    "expectedAmount" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedByName" TEXT,
    "snapshot" JSONB,
    "perfOverride" DECIMAL(5,2),
    "perfNote" TEXT,
    "perfByName" TEXT,
    "perfAt" TIMESTAMP(3),
    "accountingSettled" BOOLEAN NOT NULL DEFAULT false,
    "settledAt" TIMESTAMP(3),
    "settledByName" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryRule" (
    "id" SERIAL NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "rules" JSONB NOT NULL,
    "note" TEXT,
    "byName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalaryRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverPayMode" (
    "id" SERIAL NOT NULL,
    "driverId" UUID NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "mode" TEXT NOT NULL,
    "regionalRate" INTEGER,
    "byName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverPayMode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyDebt" (
    "id" SERIAL NOT NULL,
    "driverId" UUID NOT NULL,
    "driverName" TEXT NOT NULL,
    "kind" "CompanyDebtKind" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByName" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByName" TEXT,
    "resolvedNote" TEXT,
    "orderNumber" TEXT,
    "settlementId" INTEGER,
    "variantId" INTEGER,
    "qty" INTEGER,
    "unitPrice" INTEGER,
    "date" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CompanyDebt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverPayment" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "driverId" UUID NOT NULL,
    "driverName" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "approvedByName" TEXT,
    "idemKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" SERIAL NOT NULL,
    "txDate" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "phone" TEXT,
    "orderId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "isDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "refunded" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'CSV',
    "emailMessageId" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedByName" TEXT NOT NULL,
    "matchedAt" TIMESTAMP(3),
    "matchedByName" TEXT,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriverSettlement_date_status_idx" ON "DriverSettlement"("date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DriverSettlement_driverId_date_key" ON "DriverSettlement"("driverId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryRule_effectiveFrom_key" ON "SalaryRule"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "DriverPayMode_driverId_effectiveFrom_key" ON "DriverPayMode"("driverId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "CompanyDebt_driverId_status_idx" ON "CompanyDebt"("driverId", "status");

-- CreateIndex
CREATE INDEX "CompanyDebt_createdAt_idx" ON "CompanyDebt"("createdAt");

-- CreateIndex
CREATE INDEX "CompanyDebt_resolvedAt_idx" ON "CompanyDebt"("resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DriverPayment_idemKey_key" ON "DriverPayment"("idemKey");

-- CreateIndex
CREATE INDEX "DriverPayment_date_kind_idx" ON "DriverPayment"("date", "kind");

-- CreateIndex
CREATE INDEX "DriverPayment_driverId_date_idx" ON "DriverPayment"("driverId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_emailMessageId_key" ON "BankTransaction"("emailMessageId");

-- CreateIndex
CREATE INDEX "BankTransaction_txDate_idx" ON "BankTransaction"("txDate");

-- CreateIndex
CREATE INDEX "BankTransaction_phone_idx" ON "BankTransaction"("phone");

-- CreateIndex
CREATE INDEX "BankTransaction_orderId_idx" ON "BankTransaction"("orderId");

-- CreateIndex
CREATE INDEX "BankTransaction_status_txDate_idx" ON "BankTransaction"("status", "txDate");


-- Автомат дутуу барааны өр: жолооч + бараа тус бүрт нэг л нээлттэй мөр (давхардахгүй)
CREATE UNIQUE INDEX "CompanyDebt_open_shortage" ON "CompanyDebt"("driverId", "variantId") WHERE "kind" = 'GOODS_NOT_RETURNED' AND "status" = 'PENDING' AND "variantId" IS NOT NULL;
-- Тооцоо нийлэхэд үүссэн өр — нэг тооцоонд нэг
CREATE UNIQUE INDEX "CompanyDebt_settlement" ON "CompanyDebt"("settlementId") WHERE "kind" = 'SETTLEMENT_DEBT';
