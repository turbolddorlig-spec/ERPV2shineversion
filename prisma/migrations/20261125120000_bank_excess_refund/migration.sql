-- #129 Банкны «Илүү» төлөлтийг буцаасан
ALTER TABLE "BankTransaction" ADD COLUMN "excessRefunded" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BankTransaction" ADD COLUMN "excessRefundedAt" TIMESTAMP(3);
ALTER TABLE "BankTransaction" ADD COLUMN "excessRefundedByName" TEXT;
