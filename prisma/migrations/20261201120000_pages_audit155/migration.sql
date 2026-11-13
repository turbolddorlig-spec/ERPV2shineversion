-- Аудит #155: үлдсэн 9 хуудас. «Хүргэсэн» тайлан status = DELIVERED шүүлтээр хуучин хэсэгчилсэн индексийг ашиглана
ALTER TABLE "Order" ADD COLUMN "paidCancelReviewedAt" TIMESTAMP(3), ADD COLUMN "paidCancelReviewedByName" TEXT;
CREATE INDEX "Order_cancelledAt_idx" ON "Order"("cancelledAt");
CREATE INDEX "Order_issueResolvedAt_idx" ON "Order"("issueResolvedAt");
CREATE INDEX "AuditLog_actorId_id_idx" ON "AuditLog"("actorId", "id");
