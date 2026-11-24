-- #215: нийлүүлэгчид мэдэгдэл (зөвхөн шинэ хүснэгт — одоо байгаа өгөгдөлд хүрэхгүй)
CREATE TABLE IF NOT EXISTS "SupplierNotice" (
  "id" SERIAL PRIMARY KEY,
  "shopId" INTEGER,
  "text" TEXT NOT NULL,
  "createdByName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  "deletedByName" TEXT
);
CREATE INDEX IF NOT EXISTS "SupplierNotice_deletedAt_shopId_idx" ON "SupplierNotice"("deletedAt", "shopId");
CREATE TABLE IF NOT EXISTS "SupplierNoticeRead" (
  "noticeId" INTEGER NOT NULL REFERENCES "SupplierNotice"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "shopId" INTEGER NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readBy" TEXT NOT NULL,
  PRIMARY KEY ("noticeId", "shopId")
);
