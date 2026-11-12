-- Аудит №5: нэг агуулахад нэг л идэвхтэй (OPEN / SUBMITTED) тооллого — давхар эхэлж залруулга 2 удаа хийгдэхээс сэргийлнэ.
-- Өгөгдөл өөрчлөхгүй. Хэрэв аль хэдийн давхардсан идэвхтэй тооллого байвал индекс үүсэхгүй (migration зогсоно) — тэгвэл
-- хуучин нэгийг нь «Цуцлах»-аар хааж дахин ажиллуулна.
CREATE UNIQUE INDEX "StockCount_one_active_per_warehouse" ON "StockCount" ("warehouseId") WHERE status IN ('OPEN', 'SUBMITTED');
