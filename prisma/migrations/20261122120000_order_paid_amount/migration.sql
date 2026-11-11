-- #124 Төлсөн дүн: урьдчилж төлсөн захиалгыг засахад дутуу / илүү төлөлтийг тооцох
ALTER TABLE "Order" ADD COLUMN "paidAmount" INTEGER NOT NULL DEFAULT 0;
-- Одоо байгаа урьдчилж төлсөн захиалга: банкны гүйлгээний нийлбэр, эсвэл (гараар) тэр үеийн нийт дүн
UPDATE "Order" o SET "paidAmount" = GREATEST(o.total, COALESCE((SELECT sum(t.amount) FROM "BankTransaction" t
  WHERE t."orderId" = o.id AND t."isDuplicate" = false AND t.refunded = false AND t.status IN ('MATCHED','EXCESS_AMOUNT','PARTIAL_PAYMENT')), 0))
WHERE o.prepaid = true;
