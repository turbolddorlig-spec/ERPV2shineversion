-- Аудит #142: «Илүү төлөлт» ба «Хойшлуулсан» шүүлтүүр 1 сая захиалгыг бүтэн уншдаг байв — хэсэгчилсэн индекс
CREATE INDEX IF NOT EXISTS "Order_overpaid_idx" ON "Order" (id DESC) WHERE prepaid = true AND status <> 'CANCELLED' AND "paidAmount" > total;
CREATE INDEX IF NOT EXISTS "Order_postponed_idx" ON "Order" (id DESC) WHERE "postponeCount" > 0;
