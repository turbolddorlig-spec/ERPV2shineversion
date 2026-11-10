-- CreateEnum
CREATE TYPE "LocationKind" AS ENUM ('WAREHOUSE', 'TRANSIT', 'STAFF', 'DRIVER');

-- CreateEnum
CREATE TYPE "MoveType" AS ENUM ('RECEIPT', 'TRANSFER_SEND', 'TRANSFER_RECEIVE', 'TRANSFER_BACK', 'TRANSFER_LOSS', 'ISSUE', 'COUNT_PLUS', 'COUNT_MINUS', 'LOAN_OUT', 'LOAN_RETURN', 'LOAN_CHARGE');

-- CreateEnum
CREATE TYPE "IssueReason" AS ENUM ('DAMAGE', 'SAMPLE', 'SUPPLIER_RETURN');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('SENT', 'RECEIVED', 'DISCREPANCY', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CountStatus" AS ENUM ('OPEN', 'SUBMITTED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CountLineStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('REQUESTED', 'ISSUED', 'CLOSED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "shelfCode" TEXT;

-- CreateTable
CREATE TABLE "Warehouse" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLocation" (
    "id" SERIAL NOT NULL,
    "kind" "LocationKind" NOT NULL,
    "warehouseId" INTEGER,
    "userId" UUID,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "locationId" INTEGER NOT NULL,
    "variantId" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("locationId","variantId")
);

-- CreateTable
CREATE TABLE "StockMove" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "MoveType" NOT NULL,
    "variantId" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "fromId" INTEGER,
    "toId" INTEGER,
    "docType" TEXT NOT NULL,
    "docId" INTEGER NOT NULL,
    "note" TEXT,
    "actorId" UUID NOT NULL,
    "actorName" TEXT NOT NULL,

    CONSTRAINT "StockMove_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReceipt" (
    "id" SERIAL NOT NULL,
    "warehouseId" INTEGER NOT NULL,
    "note" TEXT,
    "idemKey" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockIssue" (
    "id" SERIAL NOT NULL,
    "warehouseId" INTEGER NOT NULL,
    "reason" "IssueReason" NOT NULL,
    "note" TEXT NOT NULL,
    "idemKey" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" SERIAL NOT NULL,
    "fromWarehouseId" INTEGER NOT NULL,
    "toWarehouseId" INTEGER NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'SENT',
    "note" TEXT,
    "refill" BOOLEAN NOT NULL DEFAULT false,
    "idemKey" TEXT NOT NULL,
    "sentById" UUID NOT NULL,
    "sentByName" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById" UUID,
    "receivedByName" TEXT,
    "receivedAt" TIMESTAMP(3),
    "resolvedById" UUID,
    "resolvedByName" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolveNote" TEXT,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransferLine" (
    "id" SERIAL NOT NULL,
    "transferId" INTEGER NOT NULL,
    "variantId" INTEGER NOT NULL,
    "sentQty" INTEGER NOT NULL,
    "receivedQty" INTEGER,
    "returnedQty" INTEGER NOT NULL DEFAULT 0,
    "lostQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StockTransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCount" (
    "id" SERIAL NOT NULL,
    "warehouseId" INTEGER NOT NULL,
    "status" "CountStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" SERIAL NOT NULL,
    "countId" INTEGER NOT NULL,
    "variantId" INTEGER NOT NULL,
    "systemQty" INTEGER NOT NULL,
    "countedQty" INTEGER NOT NULL,
    "countedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "countedById" UUID NOT NULL,
    "countedByName" TEXT NOT NULL,
    "status" "CountLineStatus" NOT NULL DEFAULT 'PENDING',
    "appliedDelta" INTEGER,
    "decidedById" UUID,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffLoan" (
    "id" SERIAL NOT NULL,
    "staffId" UUID NOT NULL,
    "staffName" TEXT NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'REQUESTED',
    "note" TEXT,
    "warehouseId" INTEGER,
    "idemKey" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" UUID,
    "issuedByName" TEXT,
    "issuedAt" TIMESTAMP(3),
    "decidedNote" TEXT,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "StaffLoan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffLoanLine" (
    "id" SERIAL NOT NULL,
    "loanId" INTEGER NOT NULL,
    "variantId" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "returnedQty" INTEGER NOT NULL DEFAULT 0,
    "chargedQty" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" INTEGER,
    "deduction" INTEGER,

    CONSTRAINT "StaffLoanLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReservation" (
    "id" SERIAL NOT NULL,
    "ref" TEXT NOT NULL,
    "variantId" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_name_key" ON "Warehouse"("name");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_warehouseId_key" ON "StockLocation"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_kind_userId_key" ON "StockLocation"("kind", "userId");

-- CreateIndex
CREATE INDEX "StockBalance_variantId_idx" ON "StockBalance"("variantId");

-- CreateIndex
CREATE INDEX "StockMove_variantId_id_idx" ON "StockMove"("variantId", "id");

-- CreateIndex
CREATE INDEX "StockMove_fromId_id_idx" ON "StockMove"("fromId", "id");

-- CreateIndex
CREATE INDEX "StockMove_toId_id_idx" ON "StockMove"("toId", "id");

-- CreateIndex
CREATE INDEX "StockMove_at_idx" ON "StockMove"("at");

-- CreateIndex
CREATE INDEX "StockMove_docType_docId_idx" ON "StockMove"("docType", "docId");

-- CreateIndex
CREATE UNIQUE INDEX "StockReceipt_idemKey_key" ON "StockReceipt"("idemKey");

-- CreateIndex
CREATE INDEX "StockReceipt_createdAt_idx" ON "StockReceipt"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockIssue_idemKey_key" ON "StockIssue"("idemKey");

-- CreateIndex
CREATE INDEX "StockIssue_createdAt_idx" ON "StockIssue"("createdAt");

-- CreateIndex
CREATE INDEX "StockIssue_reason_createdAt_idx" ON "StockIssue"("reason", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_idemKey_key" ON "StockTransfer"("idemKey");

-- CreateIndex
CREATE INDEX "StockTransfer_status_toWarehouseId_idx" ON "StockTransfer"("status", "toWarehouseId");

-- CreateIndex
CREATE INDEX "StockTransfer_sentAt_idx" ON "StockTransfer"("sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransferLine_transferId_variantId_key" ON "StockTransferLine"("transferId", "variantId");

-- CreateIndex
CREATE INDEX "StockCount_status_warehouseId_idx" ON "StockCount"("status", "warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_countId_variantId_key" ON "StockCountLine"("countId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffLoan_idemKey_key" ON "StaffLoan"("idemKey");

-- CreateIndex
CREATE INDEX "StaffLoan_status_requestedAt_idx" ON "StaffLoan"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "StaffLoan_staffId_requestedAt_idx" ON "StaffLoan"("staffId", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StaffLoanLine_loanId_variantId_key" ON "StaffLoanLine"("loanId", "variantId");

-- CreateIndex
CREATE INDEX "StockReservation_variantId_idx" ON "StockReservation"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "StockReservation_ref_variantId_key" ON "StockReservation"("ref", "variantId");

-- CreateIndex
CREATE INDEX "Product_shelfCode_idx" ON "Product"("shelfCode");

-- AddForeignKey
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockCount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffLoanLine" ADD CONSTRAINT "StaffLoanLine_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "StaffLoan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───── Модуль 2 хамгаалалт ─────
-- Үлдэгдэл хэзээ ч сөрөг болохгүй
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_qty_nonneg" CHECK ("qty" >= 0);
-- Хөдөлгөөн бүр эерэг тоотой, дор хаяж нэг талтай, өөрөөсөө өөр рүүгээ биш
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_qty_pos" CHECK ("qty" > 0);
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_sides" CHECK (("fromId" IS NOT NULL OR "toId" IS NOT NULL) AND ("fromId" IS DISTINCT FROM "toId"));
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_qty" CHECK ("sentQty" > 0 AND ("receivedQty" IS NULL OR ("receivedQty" >= 0 AND "receivedQty" <= "sentQty")) AND "returnedQty" >= 0 AND "lostQty" >= 0);
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_qty" CHECK ("countedQty" >= 0 AND "systemQty" >= 0);
ALTER TABLE "StaffLoanLine" ADD CONSTRAINT "StaffLoanLine_qty" CHECK ("qty" > 0 AND "returnedQty" >= 0 AND "chargedQty" >= 0 AND "returnedQty" + "chargedQty" <= "qty" AND ("deduction" IS NULL OR "deduction" >= 0));
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_qty" CHECK ("qty" > 0);
-- Яг нэг үндсэн агуулах
CREATE UNIQUE INDEX "Warehouse_one_primary" ON "Warehouse" ("isPrimary") WHERE "isPrimary";
-- Замдаа (шилжүүлэг) газар — ганц
CREATE UNIQUE INDEX "StockLocation_one_transit" ON "StockLocation" ("kind") WHERE "kind" = 'TRANSIT';
INSERT INTO "StockLocation" ("kind", "name") VALUES ('TRANSIT', 'Замдаа');

-- Журналыг засах, устгах боломжгүй (AuditLog-ийн адил)
CREATE OR REPLACE FUNCTION stock_move_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'StockMove is append-only (% not allowed)', TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER stock_move_no_update BEFORE UPDATE ON "StockMove" FOR EACH ROW EXECUTE FUNCTION stock_move_append_only();
CREATE TRIGGER stock_move_no_delete BEFORE DELETE ON "StockMove" FOR EACH ROW EXECUTE FUNCTION stock_move_append_only();
CREATE TRIGGER stock_move_no_truncate BEFORE TRUNCATE ON "StockMove" FOR EACH STATEMENT EXECUTE FUNCTION stock_move_append_only();

-- Зээлийн хямдралын анхны утга (#38)
INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES ('loanDiscount', '5000', now());
