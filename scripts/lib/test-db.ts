import type { PrismaClient } from '@prisma/client';

/**
 * ЗӨВХӨН ТЕСТИЙН database-ийг цэвэрлэнэ. Түүх (AuditLog) ба журнал (StockMove)-ын хамгаалалтыг
 * түр унтрааж цэвэрлээд буцааж асаана — production-д хэзээ ч ашиглахгүй (setup.ts нь *test* DB шаардана).
 */
export async function resetDb(db: PrismaClient) {
  if (!/test/.test(process.env.DATABASE_URL ?? '')) throw new Error('resetDb зөвхөн тест database дээр');
  await db.$transaction([
    db.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER USER'),
    db.$executeRawUnsafe('ALTER TABLE "StockMove" DISABLE TRIGGER USER'),
    db.$executeRawUnsafe(`TRUNCATE "StockMove", "StockBalance", "StockReceipt", "StockIssue", "StockTransferLine", "StockTransfer",
      "StockCountLine", "StockCount", "StaffLoanLine", "StaffLoan", "StockReservation", "IdemKey", "Warehouse",
      "ProductImage", "ProductVariant", "Product", "Category", "Season", "AuditReview", "Session", "User", "AuditLog", "StockLocation" RESTART IDENTITY CASCADE`),
    // «Замдаа» газрыг migration-ийн адил дахин үүсгэнэ (id = 1)
    db.$executeRawUnsafe(`INSERT INTO "StockLocation" ("kind", "name") VALUES ('TRANSIT', 'Замдаа')`),
    db.$executeRawUnsafe(`INSERT INTO "AppSetting" ("key","value","updatedAt") VALUES ('loanDiscount','5000',now()) ON CONFLICT ("key") DO UPDATE SET "value" = '5000'`),
    db.$executeRawUnsafe('ALTER TABLE "StockMove" ENABLE TRIGGER USER'),
    db.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE TRIGGER USER'),
  ]);
}
