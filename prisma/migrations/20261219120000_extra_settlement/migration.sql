-- #175: нэмэлт барааны тусдаа тооцоо
ALTER TABLE "DriverDoc" ADD COLUMN "fee" INTEGER;
ALTER TABLE "DriverDoc" ADD COLUMN "settledAt" TIMESTAMP(3);
ALTER TABLE "DriverDoc" ADD COLUMN "settledByName" TEXT;
CREATE INDEX "DriverDoc_kind_status_driverId_idx" ON "DriverDoc"("kind", "status", "driverId");
