/**
 * ТЕСТИЙН агуулахын өгөгдөл (Модуль 2): 6 агуулах (1 үндсэн), хувилбар бүрт үлдэгдэл,
 * STOCK_ROUNDS (анхдагч 5) давталтаар журналын мөр: орлого → шилжүүлэг (илгээх/хүлээн авах) → зарлага.
 * 60,000 хувилбар × 5 × 4 ≈ 1,200,000 хөдөлгөөн (R1 ачааллын тест). Үлдэгдлийг журналаас тооцно (тулгалт = 0).
 * Зөвхөн ALLOW_TEST_SEED=1 үед, бараа (seed-test-products) үүссэний дараа. Агуулах аль хэдийн байвал юу ч хийхгүй.
 */
import { PrismaClient } from '@prisma/client';

if (process.env.ALLOW_TEST_SEED !== '1') {
  console.error('Татгалзлаа: ALLOW_TEST_SEED=1 тохируулаагүй байна.');
  process.exit(1);
}
const ROUNDS = Number(process.env.STOCK_ROUNDS ?? 5);
const NAMES = ['Төв агуулах', 'Агуулах 2', 'Агуулах 3', 'Агуулах 4', 'Агуулах 5', 'Агуулах 6'];

async function main() {
  const db = new PrismaClient();
  if (await db.warehouse.count()) { console.log('Агуулах аль хэдийн бий — алгаслаа.'); await db.$disconnect(); return; }
  const actor = await db.user.findFirst({ where: { roles: { has: 'WAREHOUSE' } } }) ?? await db.user.findFirstOrThrow();
  const locs: number[] = [];
  for (const [i, name] of NAMES.entries()) {
    const w = await db.warehouse.create({ data: { name, isPrimary: i === 0, sortOrder: i + 1, address: i === 0 ? 'Тавиуртай үндсэн агуулах' : null } });
    locs.push((await db.stockLocation.create({ data: { kind: 'WAREHOUSE', warehouseId: w.id, name } })).id);
  }
  const transit = (await db.stockLocation.findFirstOrThrow({ where: { kind: 'TRANSIT' } })).id;
  const primary = locs[0]!;
  const t0 = Date.now();
  // Давталт бүрт хувилбар бүр: 2–6-р агуулахад орлого 12, үндсэн рүү 4 шилжүүлж, үндсэнээс 1 зарлага
  for (let k = 1; k <= ROUNDS; k++) {
    const src = locs[1 + ((k - 1) % 5)]!;
    await db.$executeRawUnsafe(`
      INSERT INTO "StockMove" ("at","type","variantId","qty","fromId","toId","docType","docId","note","actorId","actorName")
      SELECT now() - make_interval(days => ${ROUNDS - k + 1} * 7) + (v.id % 1000) * interval '1 minute', t.type::"MoveType", v.id, t.qty, t.f, t.tt, t.doc, ${k}, 'Тест өгөгдөл', '${actor.id}'::uuid, '${actor.name.replace(/'/g, "''")}'
      FROM "ProductVariant" v
      CROSS JOIN (VALUES ('RECEIPT', 12, NULL::int, ${src}, 'receipt'),
                         ('TRANSFER_SEND', 4, ${src}, ${transit}, 'transfer'),
                         ('TRANSFER_RECEIVE', 4, ${transit}, ${primary}, 'transfer'),
                         ('ISSUE', 1, ${primary}, NULL::int, 'issue')) AS t(type, qty, f, tt, doc)`);
    console.log(`  давталт ${k}/${ROUNDS} (${((Date.now() - t0) / 1000).toFixed(0)} сек)`);
  }
  // Үлдэгдэл = журналын нийлбэр
  await db.$executeRawUnsafe(`
    INSERT INTO "StockBalance" ("locationId","variantId","qty","updatedAt")
    SELECT loc, "variantId", sum(q)::int, now() FROM (
      SELECT "toId" AS loc, "variantId", qty AS q FROM "StockMove" WHERE "toId" IS NOT NULL
      UNION ALL SELECT "fromId", "variantId", -qty FROM "StockMove" WHERE "fromId" IS NOT NULL) x
    GROUP BY loc, "variantId" HAVING sum(q) <> 0
    ON CONFLICT ("locationId","variantId") DO UPDATE SET qty = EXCLUDED.qty`);
  // Тавиурын код (үндсэн агуулах): ангиллаар A–L тавиур
  await db.$executeRawUnsafe(`UPDATE "Product" SET "shelfCode" = chr(64 + ((COALESCE("categoryId", 1) - 1) % 12) + 1) || '-' || ((id % 9) + 1)`);
  // Дүүргэлтийн жишээ: 40 хувилбарт тавиураас их захиалга (Модуль 3-ыг дуурайна)
  await db.$executeRawUnsafe(`
    INSERT INTO "StockReservation" ("ref","variantId","qty")
    SELECT 'TEST-' || v.id, v.id, b.qty + 5 + (v.id % 20) FROM "ProductVariant" v
    JOIN "StockBalance" b ON b."variantId" = v.id AND b."locationId" = ${primary}
    ORDER BY v.id LIMIT 40`);
  const n = await db.stockMove.count();
  console.log(`Дууслаа: 6 агуулах, ${n.toLocaleString('en-US')} хөдөлгөөн, ${((Date.now() - t0) / 1000).toFixed(0)} сек.`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
