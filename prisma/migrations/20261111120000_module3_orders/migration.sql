-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'NEW', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CancelReason" AS ENUM ('CUSTOMER_CANCELLED', 'DUPLICATE', 'OUT_OF_STOCK', 'NO_ANSWER', 'PAYMENT_TIMEOUT', 'OTHER');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('PENDING', 'CONTACTED', 'ORDERED', 'CANCELLED', 'TRANSFERRED');

-- CreateEnum
CREATE TYPE "CallCloseReason" AS ENUM ('NO_ANSWER', 'PRICE', 'OUT_OF_STOCK', 'NO_SIZE_COLOR', 'DELIVERY', 'JUST_ASKING', 'BOUGHT_ELSEWHERE', 'OTHER');

-- CreateEnum
CREATE TYPE "TransferRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MetaEventStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "deliveryIncluded" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "StockReservation" ADD COLUMN     "orderId" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastPageId" INTEGER;

-- CreateTable
CREATE TABLE "Page" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageAssignment" (
    "userId" UUID NOT NULL,
    "pageIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "PageAssignment_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "phone" TEXT NOT NULL,
    "extraPhone" TEXT,
    "province" TEXT NOT NULL,
    "district" TEXT,
    "khoroo" INTEGER,
    "addressDetail" TEXT NOT NULL,
    "note" TEXT,
    "pageId" INTEGER NOT NULL,
    "operatorId" UUID NOT NULL,
    "operatorName" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "prepaid" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "paymentDeadline" TIMESTAMP(3),
    "subtotal" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "deliveryFee" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "deliveryFeeEdited" BOOLEAN NOT NULL DEFAULT false,
    "blacklistNote" TEXT,
    "postponeCount" INTEGER NOT NULL DEFAULT 0,
    "handoverId" INTEGER,
    "cancelReason" "CancelReason",
    "cancelNote" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByName" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "idemKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "variantId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "imageKey" TEXT,
    "listPrice" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "discountReason" TEXT,
    "deliveryIncluded" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlacklistEntry" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "orderNumber" TEXT,
    "reportedById" UUID,
    "reportedBy" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "removedBy" TEXT,
    "removedAt" TIMESTAMP(3),
    "removeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlacklistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallNote" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "variantId" INTEGER,
    "productText" TEXT,
    "pageId" INTEGER,
    "note" TEXT,
    "status" "CallStatus" NOT NULL DEFAULT 'PENDING',
    "ownerId" UUID NOT NULL,
    "ownerName" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "orderId" INTEGER,
    "closeReason" "CallCloseReason",
    "closeNote" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallNoteTransfer" (
    "id" SERIAL NOT NULL,
    "noteId" INTEGER NOT NULL,
    "fromId" UUID NOT NULL,
    "fromName" TEXT NOT NULL,
    "toId" UUID NOT NULL,
    "toName" TEXT NOT NULL,
    "status" "TransferRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "CallNoteTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaEvent" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "status" "MetaEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Page_name_key" ON "Page"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Order_number_key" ON "Order"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Order_idemKey_key" ON "Order"("idemKey");

-- CreateIndex
CREATE INDEX "Order_status_deliveryDate_idx" ON "Order"("status", "deliveryDate");

-- CreateIndex
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Order_confirmedAt_idx" ON "Order"("confirmedAt");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "Order_phone_idx" ON "Order"("phone");

-- CreateIndex
CREATE INDEX "Order_extraPhone_idx" ON "Order"("extraPhone");

-- CreateIndex
CREATE INDEX "Order_pageId_confirmedAt_idx" ON "Order"("pageId", "confirmedAt");

-- CreateIndex
CREATE INDEX "Order_operatorId_confirmedAt_idx" ON "Order"("operatorId", "confirmedAt");

-- CreateIndex
CREATE INDEX "Order_status_paymentDeadline_idx" ON "Order"("status", "paymentDeadline");

-- CreateIndex
CREATE INDEX "OrderLine_variantId_idx" ON "OrderLine"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_orderId_variantId_key" ON "OrderLine"("orderId", "variantId");

-- CreateIndex
CREATE INDEX "BlacklistEntry_phone_isActive_idx" ON "BlacklistEntry"("phone", "isActive");

-- CreateIndex
CREATE INDEX "BlacklistEntry_createdAt_idx" ON "BlacklistEntry"("createdAt");

-- CreateIndex
CREATE INDEX "CallNote_ownerId_status_idx" ON "CallNote"("ownerId", "status");

-- CreateIndex
CREATE INDEX "CallNote_phone_idx" ON "CallNote"("phone");

-- CreateIndex
CREATE INDEX "CallNote_createdAt_idx" ON "CallNote"("createdAt");

-- CreateIndex
CREATE INDEX "CallNote_status_createdAt_idx" ON "CallNote"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CallNoteTransfer_toId_status_idx" ON "CallNoteTransfer"("toId", "status");

-- CreateIndex
CREATE INDEX "CallNoteTransfer_noteId_idx" ON "CallNoteTransfer"("noteId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaEvent_orderId_key" ON "MetaEvent"("orderId");

-- CreateIndex
CREATE INDEX "MetaEvent_status_nextAttemptAt_idx" ON "MetaEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "StockReservation_orderId_idx" ON "StockReservation"("orderId");

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallNoteTransfer" ADD CONSTRAINT "CallNoteTransfer_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "CallNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───── Модуль 3 хамгаалалт, хурд ─────
-- Захиалгын 8 оронтой дугаар (хэзээ ч солигдохгүй)
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1;

-- Дүн, тоо зөв байх
ALTER TABLE "Order" ADD CONSTRAINT "Order_money" CHECK ("subtotal" >= 0 AND "discount" >= 0 AND "deliveryFee" >= 0 AND "total" >= 0 AND "total" = "subtotal" - "discount" + "deliveryFee");
ALTER TABLE "Order" ADD CONSTRAINT "Order_phone" CHECK ("phone" ~ '^[0-9]{8}$' AND ("extraPhone" IS NULL OR ("extraPhone" ~ '^[0-9]{8}$' AND "extraPhone" <> "phone")));
ALTER TABLE "Order" ADD CONSTRAINT "Order_khoroo" CHECK ("khoroo" IS NULL OR ("khoroo" BETWEEN 1 AND 60));
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_qty" CHECK ("qty" > 0 AND "unitPrice" > 0 AND "listPrice" > 0 AND "unitPrice" <= "listPrice");
ALTER TABLE "CallNote" ADD CONSTRAINT "CallNote_attempts" CHECK ("attempts" BETWEEN 0 AND 5);

-- Хайлт (1 сая захиалга): утас, хаяг, тэмдэглэл, барааны нэр — trigram
CREATE INDEX "Order_phone_trgm" ON "Order" USING gin ("phone" gin_trgm_ops);
CREATE INDEX "Order_extraPhone_trgm" ON "Order" USING gin ("extraPhone" gin_trgm_ops);
CREATE INDEX "Order_address_trgm" ON "Order" USING gin ("addressDetail" gin_trgm_ops);
CREATE INDEX "Order_note_trgm" ON "Order" USING gin ("note" gin_trgm_ops);
CREATE INDEX "OrderLine_name_trgm" ON "OrderLine" USING gin ("name" gin_trgm_ops);
CREATE INDEX "OrderLine_code_trgm" ON "OrderLine" USING gin ("code" gin_trgm_ops);
-- Идэвхтэй захиалга (давхардал шалгах) — жижиг хэсэгчилсэн индекс
CREATE INDEX "Order_active_phone" ON "Order" ("phone") WHERE "status" IN ('PENDING_PAYMENT','NEW','ASSIGNED');
CREATE INDEX "Order_active_extra" ON "Order" ("extraPhone") WHERE "status" IN ('PENDING_PAYMENT','NEW','ASSIGNED') AND "extraPhone" IS NOT NULL;
CREATE INDEX "OrderLine_orderId" ON "OrderLine" ("orderId");

-- Анхны тохиргоо (#43): хүргэлтийн төлбөр, төлбөр хүлээх хоног
INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES
  ('deliveryFeeUB', '5000', now()), ('deliveryFeeRural', '10000', now()), ('paymentWaitDays', '7', now())
ON CONFLICT ("key") DO NOTHING;
