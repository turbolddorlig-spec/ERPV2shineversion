-- #80: нэмэлт бараа падаанаар — жолоочийн хүсэлт → падаанд тусдаа → агуулах өгч, жолооч хүлээн авахад шилжинэ
ALTER TABLE "DriverDoc" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DONE',
  ADD COLUMN "date" DATE,
  ADD COLUMN "handoverId" INTEGER;
CREATE INDEX "DriverDoc_handoverId_idx" ON "DriverDoc"("handoverId");
CREATE INDEX "DriverDoc_driverId_status_idx" ON "DriverDoc"("driverId", "status");

-- Падааны Check: захиалгын бараа ба нэмэлт бараа тусдаа (ижил бараа хоёуланд байж болно)
ALTER TABLE "HandoverCheck" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'ORDER';
ALTER TABLE "HandoverCheck" DROP CONSTRAINT "HandoverCheck_pkey";
ALTER TABLE "HandoverCheck" ADD CONSTRAINT "HandoverCheck_pkey" PRIMARY KEY ("handoverId", "variantId", "kind");
