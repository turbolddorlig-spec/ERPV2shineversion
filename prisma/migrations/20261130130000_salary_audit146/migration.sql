-- Аудит #146: цалингийн өөрчлөлтийг Супер админы бодсонтой харьцуулах
ALTER TABLE "StaffSalaryRecord" ADD COLUMN "saSnapshot" JSONB, ADD COLUMN "trackChanges" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "changedByName" TEXT;
ALTER TABLE "StaffSalaryConfig" ADD COLUMN "saSnapshot" JSONB;
ALTER TABLE "ExternalStaff" ADD COLUMN "saSnapshot" JSONB;
-- Операторын захиалгын тоолол — хүснэгт уншихгүй (index-only)
CREATE INDEX IF NOT EXISTS "Order_operator_salary_idx" ON "Order" ("operatorId", "confirmedAt") INCLUDE (status, prepaid, "postponeCount", "deliveryDate");
