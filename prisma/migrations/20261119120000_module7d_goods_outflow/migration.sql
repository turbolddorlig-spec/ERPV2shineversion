-- Модуль 7г (#104–#110): барааны гарц, маркетинг, бүүстийн ашиг











-- CreateTable
CREATE TABLE "ProductMarketing" (
    "productId" INTEGER NOT NULL,
    "ownerId" UUID,
    "ownerName" TEXT,
    "doneAt" TIMESTAMP(3),
    "doneByName" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "dollar" INTEGER NOT NULL DEFAULT 5,
    "zones" INTEGER NOT NULL DEFAULT 0,
    "adNumber" INTEGER,
    "boostOnAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByName" TEXT,

    CONSTRAINT "ProductMarketing_pkey" PRIMARY KEY ("productId")
);

-- CreateTable
CREATE TABLE "BoostEvent" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dollar" INTEGER NOT NULL,
    "zones" INTEGER NOT NULL,
    "adNumber" INTEGER,
    "byId" UUID,
    "byName" TEXT NOT NULL,

    CONSTRAINT "BoostEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingPage" (
    "pageId" INTEGER NOT NULL,
    "userId" UUID NOT NULL,
    "userName" TEXT NOT NULL,
    "updatedByName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingPage_pkey" PRIMARY KEY ("pageId")
);

-- CreateTable
CREATE TABLE "WorkClaim" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "userId" UUID NOT NULL,
    "userName" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "endedAt" TIMESTAMP(3),
    "endedByName" TEXT,

    CONSTRAINT "WorkClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingScore" (
    "id" SERIAL NOT NULL,
    "userId" UUID NOT NULL,
    "userName" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "score" INTEGER,
    "salaryAmount" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "boostCount" INTEGER NOT NULL DEFAULT 0,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "scoredById" UUID NOT NULL,
    "scoredByName" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoostWatch" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "byId" UUID NOT NULL,
    "byName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoostWatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductMarketing_ownerId_idx" ON "ProductMarketing"("ownerId");

-- CreateIndex
CREATE INDEX "ProductMarketing_zones_idx" ON "ProductMarketing"("zones");

-- CreateIndex
CREATE INDEX "BoostEvent_productId_at_idx" ON "BoostEvent"("productId", "at");

-- CreateIndex
CREATE INDEX "BoostEvent_at_idx" ON "BoostEvent"("at");

-- CreateIndex
CREATE INDEX "MarketingPage_userId_idx" ON "MarketingPage"("userId");

-- CreateIndex
CREATE INDEX "WorkClaim_userId_status_idx" ON "WorkClaim"("userId", "status");

-- CreateIndex
CREATE INDEX "WorkClaim_productId_idx" ON "WorkClaim"("productId");

-- CreateIndex
CREATE INDEX "WorkClaim_status_idx" ON "WorkClaim"("status");

-- CreateIndex
CREATE INDEX "MarketingScore_date_idx" ON "MarketingScore"("date");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingScore_userId_date_key" ON "MarketingScore"("userId", "date");

-- CreateIndex
CREATE INDEX "BoostWatch_productId_until_idx" ON "BoostWatch"("productId", "until");


-- Нэг барааг нэг л хүн сонгоно
CREATE UNIQUE INDEX "WorkClaim_active_product" ON "WorkClaim"("productId") WHERE status = 'ACTIVE';
