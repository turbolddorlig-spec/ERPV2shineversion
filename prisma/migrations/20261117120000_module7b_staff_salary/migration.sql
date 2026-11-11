-- Модуль 7б (#93): ажилтны цалин
-- AlterTable
ALTER TABLE "Penalty" ADD COLUMN     "deductedAmount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "StaffSalaryConfig" (
    "userId" UUID NOT NULL,
    "salaryType" TEXT NOT NULL DEFAULT 'FIXED',
    "baseSalary" INTEGER NOT NULL DEFAULT 0,
    "bonusSalary" INTEGER NOT NULL DEFAULT 0,
    "oppRatePerOrder" INTEGER NOT NULL DEFAULT 0,
    "dailyRate" INTEGER NOT NULL DEFAULT 0,
    "bankName" TEXT NOT NULL DEFAULT '',
    "bankAccount" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByName" TEXT,

    CONSTRAINT "StaffSalaryConfig_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ExternalStaff" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "baseSalary" INTEGER NOT NULL DEFAULT 0,
    "bankName" TEXT NOT NULL DEFAULT '',
    "bankAccount" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalStaff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffWorkDay" (
    "staffKey" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "dayType" TEXT NOT NULL,
    "note" TEXT,
    "byName" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffWorkDay_pkey" PRIMARY KEY ("staffKey","date")
);

-- CreateTable
CREATE TABLE "StaffSalaryRecord" (
    "id" SERIAL NOT NULL,
    "staffKey" TEXT NOT NULL,
    "userId" UUID,
    "externalId" INTEGER,
    "staffName" TEXT NOT NULL,
    "staffRole" TEXT NOT NULL DEFAULT '',
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "salaryType" TEXT NOT NULL DEFAULT 'FIXED',
    "workingDays" INTEGER NOT NULL DEFAULT 0,
    "totalDays" INTEGER NOT NULL DEFAULT 0,
    "dailyRate" INTEGER NOT NULL DEFAULT 0,
    "baseSalary" INTEGER NOT NULL DEFAULT 0,
    "bonusSalary" INTEGER NOT NULL DEFAULT 0,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "orderRate" INTEGER NOT NULL DEFAULT 0,
    "orderSalary" INTEGER NOT NULL DEFAULT 0,
    "additions" JSONB NOT NULL DEFAULT '[]',
    "totalAdditions" INTEGER NOT NULL DEFAULT 0,
    "deductions" JSONB NOT NULL DEFAULT '[]',
    "totalDeductions" INTEGER NOT NULL DEFAULT 0,
    "penaltyTotal" INTEGER NOT NULL DEFAULT 0,
    "penaltyDeducted" INTEGER NOT NULL DEFAULT 0,
    "loans" JSONB NOT NULL DEFAULT '[]',
    "loanTotal" INTEGER NOT NULL DEFAULT 0,
    "debtPayments" JSONB NOT NULL DEFAULT '[]',
    "debtTotal" INTEGER NOT NULL DEFAULT 0,
    "grossSalary" INTEGER NOT NULL DEFAULT 0,
    "transferSalary" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "bankName" TEXT NOT NULL DEFAULT '',
    "bankAccount" TEXT NOT NULL DEFAULT '',
    "transferred" BOOLEAN NOT NULL DEFAULT false,
    "transferredAt" TIMESTAMP(3),
    "transferredByName" TEXT,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "lockedAt" TIMESTAMP(3),
    "lockedByName" TEXT,
    "applied" JSONB,
    "createdByName" TEXT NOT NULL,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "StaffSalaryRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffDebt" (
    "id" SERIAL NOT NULL,
    "staffKey" TEXT NOT NULL,
    "staffName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "remainingAmount" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByName" TEXT NOT NULL,

    CONSTRAINT "StaffDebt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffDebtPayment" (
    "id" SERIAL NOT NULL,
    "debtId" INTEGER NOT NULL,
    "recordId" INTEGER,
    "periodLabel" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByName" TEXT NOT NULL,

    CONSTRAINT "StaffDebtPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffWorkDay_date_idx" ON "StaffWorkDay"("date");

-- CreateIndex
CREATE INDEX "StaffSalaryRecord_periodStart_idx" ON "StaffSalaryRecord"("periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "StaffSalaryRecord_staffKey_periodStart_key" ON "StaffSalaryRecord"("staffKey", "periodStart");

-- CreateIndex
CREATE INDEX "StaffDebt_staffKey_isActive_idx" ON "StaffDebt"("staffKey", "isActive");

-- CreateIndex
CREATE INDEX "StaffDebtPayment_debtId_idx" ON "StaffDebtPayment"("debtId");

-- CreateIndex
CREATE INDEX "StaffDebtPayment_recordId_idx" ON "StaffDebtPayment"("recordId");

-- AddForeignKey
ALTER TABLE "StaffDebtPayment" ADD CONSTRAINT "StaffDebtPayment_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "StaffDebt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

