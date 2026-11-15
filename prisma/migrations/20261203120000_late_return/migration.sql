-- Аудит #160: түгжсэн өдрийн хүргэсэн захиалгын хожуу буцаалт
ALTER TABLE "Order" ADD COLUMN "lateCancelledAt" TIMESTAMP(3), ADD COLUMN "lateCancelByName" TEXT, ADD COLUMN "lateCancelNote" TEXT;
CREATE INDEX "Order_lateCancelledAt_idx" ON "Order"("lateCancelledAt");
CREATE INDEX "Order_operatorId_lateCancelledAt_idx" ON "Order"("operatorId", "lateCancelledAt");
