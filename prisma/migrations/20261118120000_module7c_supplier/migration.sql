-- Модуль 7в (#96–#98): нийлүүлэгч (гадны дэлгүүр)

-- CreateTable
CREATE TABLE "SupplierShop" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT NOT NULL DEFAULT '',
    "contactPhone" TEXT NOT NULL DEFAULT '',
    "userId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierShop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierProduct" (
    "id" SERIAL NOT NULL,
    "shopId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE,
    "createdByName" TEXT NOT NULL,
    "endedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierDeduction" (
    "shopId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "operatorCost" INTEGER NOT NULL DEFAULT 0,
    "deliveryCost" INTEGER NOT NULL DEFAULT 0,
    "marketingCost" INTEGER NOT NULL DEFAULT 0,
    "otherCost" INTEGER NOT NULL DEFAULT 0,
    "otherNote" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByName" TEXT,

    CONSTRAINT "SupplierDeduction_pkey" PRIMARY KEY ("shopId","productId")
);

-- CreateTable
CREATE TABLE "SupplierDay" (
    "id" SERIAL NOT NULL,
    "shopId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "overrides" JSONB,
    "snapshot" JSONB,
    "sales" INTEGER NOT NULL DEFAULT 0,
    "deductions" INTEGER NOT NULL DEFAULT 0,
    "net" INTEGER NOT NULL DEFAULT 0,
    "adjustments" INTEGER NOT NULL DEFAULT 0,
    "payable" INTEGER NOT NULL DEFAULT 0,
    "transferredAt" TIMESTAMP(3),
    "transferredByName" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierDayItem" (
    "id" SERIAL NOT NULL,
    "dayId" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "productId" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "sales" INTEGER NOT NULL,
    "deduction" INTEGER NOT NULL,
    "adjustedQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SupplierDayItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierAdjustment" (
    "id" SERIAL NOT NULL,
    "shopId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceDayId" INTEGER,
    "sourceDate" DATE,
    "orderNumber" TEXT,
    "productId" INTEGER,
    "productName" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "sales" INTEGER NOT NULL DEFAULT 0,
    "deduction" INTEGER NOT NULL DEFAULT 0,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "appliedDayId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierShop_name_key" ON "SupplierShop"("name");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierShop_userId_key" ON "SupplierShop"("userId");

-- CreateIndex
CREATE INDEX "SupplierProduct_shopId_idx" ON "SupplierProduct"("shopId");

-- CreateIndex
CREATE INDEX "SupplierProduct_productId_idx" ON "SupplierProduct"("productId");

-- CreateIndex
CREATE INDEX "SupplierDay_status_idx" ON "SupplierDay"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierDay_shopId_date_key" ON "SupplierDay"("shopId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierDayItem_dayId_source_productId_key" ON "SupplierDayItem"("dayId", "source", "productId");

-- CreateIndex
CREATE INDEX "SupplierAdjustment_shopId_appliedDayId_idx" ON "SupplierAdjustment"("shopId", "appliedDayId");

-- CreateIndex
CREATE INDEX "SupplierAdjustment_sourceDayId_idx" ON "SupplierAdjustment"("sourceDayId");

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "SupplierShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierDeduction" ADD CONSTRAINT "SupplierDeduction_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "SupplierShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierDay" ADD CONSTRAINT "SupplierDay_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "SupplierShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierDayItem" ADD CONSTRAINT "SupplierDayItem_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "SupplierDay"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierAdjustment" ADD CONSTRAINT "SupplierAdjustment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "SupplierShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Нэг бараа зөвхөн нэг нийлүүлэгчид (нээлттэй хувиарлалт) — давхар төлөхөөс сэргийлнэ
CREATE UNIQUE INDEX "SupplierProduct_open_product" ON "SupplierProduct"("productId") WHERE "toDate" IS NULL;
