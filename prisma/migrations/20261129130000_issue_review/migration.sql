-- Аудит #143: зарлагыг админ хянасан тэмдэг (зарлага шууд гарна, админд жагсаалт)
ALTER TABLE "StockIssue" ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
ALTER TABLE "StockIssue" ADD COLUMN IF NOT EXISTS "reviewedByName" TEXT;
CREATE INDEX IF NOT EXISTS "StockIssue_unreviewed_idx" ON "StockIssue" ("createdAt" DESC) WHERE "reviewedAt" IS NULL;
