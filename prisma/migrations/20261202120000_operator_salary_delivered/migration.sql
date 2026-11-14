-- Аудит #157: операторын цалин — хүргэсэн өдрөөр (operatorId + deliveredAt, зөвхөн хүргэсэн)
CREATE INDEX IF NOT EXISTS "Order_operator_delivered_idx" ON "Order" ("operatorId", "deliveredAt") WHERE status = 'DELIVERED';
