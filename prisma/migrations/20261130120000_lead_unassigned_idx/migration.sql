-- Аудит #145: ахлахын «Хуваарилаагүй» жагсаалт (status='NEW' AND driverId IS NULL, id DESC) — 1 сая мөр бүтэн уншихгүй
CREATE INDEX IF NOT EXISTS "Order_unassigned_new_idx" ON "Order" (id DESC) WHERE status = 'NEW' AND "driverId" IS NULL;
