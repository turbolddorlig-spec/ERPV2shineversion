-- Аудит #149: хүсэлтийн үеийн үнэ (үнийг түр бууруулж суутгал багасгахаас сэргийлнэ)
ALTER TABLE "StaffLoanLine" ADD COLUMN IF NOT EXISTS "requestPrice" INTEGER;
