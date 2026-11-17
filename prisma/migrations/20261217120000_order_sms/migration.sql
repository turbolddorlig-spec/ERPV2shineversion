-- #166: «Төлбөр хүлээж буй» захиалгын SMS
CREATE TYPE "SmsStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

CREATE TABLE "SmsMessage" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "phone" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "SmsStatus" NOT NULL DEFAULT 'PENDING',
    "test" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "response" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SmsMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SmsMessage_orderId_key" ON "SmsMessage"("orderId");
CREATE INDEX "SmsMessage_status_nextAttemptAt_idx" ON "SmsMessage"("status", "nextAttemptAt");
CREATE INDEX "SmsMessage_createdAt_idx" ON "SmsMessage"("createdAt");
