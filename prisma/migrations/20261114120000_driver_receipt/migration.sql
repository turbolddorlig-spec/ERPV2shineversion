-- #77: жолооч падаанаа утсаараа хүлээн авах
ALTER TYPE "HandoverStatus" ADD VALUE 'RECEIVED';
ALTER TABLE "Handover" ADD COLUMN "receivedAt" TIMESTAMP(3), ADD COLUMN "receivedBy" TEXT;
ALTER TABLE "HandoverCheck" ADD COLUMN "driverCheckedAt" TIMESTAMP(3);
