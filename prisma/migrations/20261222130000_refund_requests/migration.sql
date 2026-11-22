-- #211: мөнгө буцаах хүсэлт (зөвхөн шинэ хүснэгт — одоо байгаа өгөгдөлд хүрэхгүй)
CREATE TABLE IF NOT EXISTS "RefundRequest" (
  "id" SERIAL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "bankTransactionId" INTEGER,
  "orderId" INTEGER,
  "orderNumber" TEXT,
  "amount" INTEGER NOT NULL,
  "bankName" TEXT NOT NULL,
  "accountNo" TEXT NOT NULL,
  "accountName" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "requestedById" TEXT NOT NULL,
  "requestedByName" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedByName" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT
);
CREATE INDEX IF NOT EXISTS "RefundRequest_status_id_idx" ON "RefundRequest"("status", "id");
CREATE INDEX IF NOT EXISTS "RefundRequest_bankTransactionId_idx" ON "RefundRequest"("bankTransactionId");
CREATE INDEX IF NOT EXISTS "RefundRequest_orderId_idx" ON "RefundRequest"("orderId");
-- Нэг гүйлгээ / захиалга дээр нэг л хүлээгдэж буй хүсэлт
CREATE UNIQUE INDEX IF NOT EXISTS "RefundRequest_pending_tx_key" ON "RefundRequest"("bankTransactionId") WHERE "status" = 'PENDING' AND "bankTransactionId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "RefundRequest_pending_order_key" ON "RefundRequest"("kind", "orderId") WHERE "status" = 'PENDING' AND "bankTransactionId" IS NULL;
