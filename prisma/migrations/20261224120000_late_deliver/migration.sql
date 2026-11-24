-- #212: хожуу «Хүргэсэн» болгосон тэмдэг (зөвхөн хоосон багана нэмнэ — одоо байгаа өгөгдөлд хүрэхгүй)
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "lateDeliveredAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "lateDeliverByName" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "lateDeliverNote" TEXT;
CREATE INDEX IF NOT EXISTS "Order_operatorId_lateDeliveredAt_idx" ON "Order"("operatorId", "lateDeliveredAt");
