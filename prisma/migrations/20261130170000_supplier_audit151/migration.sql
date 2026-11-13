-- Аудит #151: нийлүүлэгчийн «Захиалсан» тэмдэг аль дэлгүүрийнх
ALTER TABLE "ReorderOrder" ADD COLUMN IF NOT EXISTS "shopId" INTEGER;
-- Хуучин тэмдгийг одоо оноогдсон дэлгүүрт холбоно
UPDATE "ReorderOrder" r SET "shopId" = sp."shopId" FROM "SupplierProduct" sp WHERE r.scope = 'SUPPLIER' AND r."shopId" IS NULL AND sp."productId" = r."productId" AND sp."toDate" IS NULL;
-- Нийлүүлэгчийн тооцоо: барааны мөрүүд (90 хоногийн нэгтгэл)
CREATE INDEX IF NOT EXISTS "OrderLine_product_order_idx" ON "OrderLine" ("productId", "orderId") INCLUDE (qty, "refusedQty", "unitPrice");
