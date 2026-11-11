-- #77: ахлах жолоочийн «Гүйцэтгэл», «График» (хүргэсэн/цуцалсан/хойшилсон өдрөөр) — 1 сая+ захиалгад хурдан
CREATE INDEX "Order_deliveredAt_idx" ON "Order"("deliveredAt") WHERE status = 'DELIVERED';
CREATE INDEX "Order_cancelledAt_driver_idx" ON "Order"("cancelledAt") WHERE status = 'CANCELLED' AND "driverId" IS NOT NULL;
CREATE INDEX "Order_postponedAt_idx" ON "Order"("postponedAt") WHERE "postponedByDriverId" IS NOT NULL;
