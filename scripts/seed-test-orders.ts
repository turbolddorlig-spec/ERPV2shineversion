/**
 * ТЕСТИЙН захиалгын өгөгдөл (Модуль 3, R1 ачаалал): 8 пэйж, SEED_ORDERS (анхдагч 1,000,000) захиалга сүүлийн 365 хоногт,
 * захиалга бүрт 1–3 мөр, ~60,000 дуудлагын тэмдэглэл, 50 хар жагсаалт.
 * Зөвхөн ALLOW_TEST_SEED=1 үед, хэрэглэгч ба бараа үүссэний дараа. Захиалга аль хэдийн байвал юу ч хийхгүй.
 * Хуучин (дууссан) захиалга нөөц үүсгэхгүй; идэвхтэй цөөн захиалгад л нөөц үүсгэнэ — үлдэгдэл хэвээр.
 */
import { PrismaClient } from '@prisma/client';

if (process.env.ALLOW_TEST_SEED !== '1') {
  console.error('Татгалзлаа: ALLOW_TEST_SEED=1 тохируулаагүй байна.');
  process.exit(1);
}
const N = Number(process.env.SEED_ORDERS ?? 1_000_000);
const BATCH = 100_000;

async function main() {
  const db = new PrismaClient();
  if (await db.order.count()) { console.log('Захиалга аль хэдийн бий — алгаслаа.'); await db.$disconnect(); return; }
  const ops = await db.user.findMany({ where: { roles: { hasSome: ['OPERATOR', 'OPERATOR_LEAD'] } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  if (!ops.length) throw new Error('Оператор алга — эхлээд seed:test ажиллуулна уу');
  if (!(await db.productVariant.count())) throw new Error('Бараа алга — эхлээд seed-test-products');
  if (!(await db.page.count())) {
    await db.page.createMany({ data: Array.from({ length: 8 }, (_, i) => ({ name: `Тест пэйж ${i + 1}`, sortOrder: i })) });
  }
  const pages = (await db.page.findMany({ select: { id: true } })).map((p) => p.id);
  const t0 = Date.now();
  // Түр хүснэгт: оператор, пэйж, хувилбар (үнэ, нэр)
  // Prisma холболтын сан өөр холболт ашиглаж болох тул түр (UNLOGGED) хүснэгт — төгсгөлд устгана
  await db.$executeRawUnsafe('DROP TABLE IF EXISTS _ops');
  await db.$executeRawUnsafe('DROP TABLE IF EXISTS _v');
  await db.$executeRawUnsafe(`CREATE UNLOGGED TABLE _ops AS SELECT row_number() OVER () - 1 AS k, x.id::uuid, x.name FROM json_to_recordset('${JSON.stringify(ops).replace(/'/g, "''")}') AS x(id text, name text)`);
  await db.$executeRawUnsafe(`CREATE UNLOGGED TABLE _v AS
    SELECT row_number() OVER (ORDER BY v.id) - 1 AS k, v.id, v."productId", v.code, p.name, trim(both ' · ' from concat_ws(' · ', nullif(v.color,''), nullif(v.size,''))) AS label,
      COALESCE(v."priceOverride", p.price) AS price, p."deliveryIncluded"
    FROM "ProductVariant" v JOIN "Product" p ON p.id = v."productId" WHERE v."isActive"`);
  const nOps = ops.length;
  const nV = Number((await db.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*) AS n FROM _v'))[0]!.n);
  const pageArr = `ARRAY[${pages.join(',')}]`;
  const DIST = `ARRAY['Баянгол','Баянзүрх','Сонгинохайрхан','Сүхбаатар','Хан-Уул','Чингэлтэй']`;
  const CAN = `ARRAY['CUSTOMER_CANCELLED','DUPLICATE','OUT_OF_STOCK','NO_ANSWER','PAYMENT_TIMEOUT','OTHER']`;

  for (let start = 1; start <= N; start += BATCH) {
    const end = Math.min(N, start + BATCH - 1);
    // h = тогтмол «санамсаргүй» тоо (хэш) — давтахад ижил үр дүн
    await db.$executeRawUnsafe(`
      WITH g AS (
        SELECT i, abs(hashint4(i)) AS h, abs(hashint4(i + 7777777)) AS h2,
          now() - ((${N} - i)::float / ${N} * 365) * interval '1 day' - (abs(hashint4(i)) % 600) * interval '1 minute' AS ts
        FROM generate_series(${start}, ${end}) i),
      s AS (
        SELECT g.*, CASE
          WHEN ts > now() - interval '1 day' THEN (ARRAY['NEW','NEW','NEW','ASSIGNED','PENDING_PAYMENT','CANCELLED'])[1 + h % 6]
          WHEN ts > now() - interval '3 day' THEN (ARRAY['ASSIGNED','ASSIGNED','DELIVERED','DELIVERED','CANCELLED','PENDING_PAYMENT'])[1 + h % 6]
          ELSE (ARRAY['DELIVERED','DELIVERED','DELIVERED','DELIVERED','DELIVERED','DELIVERED','CANCELLED','CANCELLED'])[1 + h % 8] END AS st,
          (h % 10 = 0) AS rural
        FROM g)
      INSERT INTO "Order" (id, number, status, phone, "extraPhone", province, district, khoroo, "addressDetail", note, "pageId", "operatorId", "operatorName",
        "deliveryDate", prepaid, "confirmedAt", "paymentDeadline", subtotal, discount, "deliveryFee", total, "cancelReason", "cancelNote", "cancelledAt", "cancelledByName",
        "deliveredAt", "idemKey", "createdAt", "updatedAt")
      SELECT i, lpad(i::text, 8, '0'), st::"OrderStatus",
        (ARRAY['8','9','7','6'])[1 + h % 4] || lpad((h % 10000000)::text, 7, '0'),
        CASE WHEN h2 % 7 = 0 THEN '9' || lpad((h2 % 10000000)::text, 7, '0') END,
        CASE WHEN rural THEN (ARRAY['Архангай','Дархан-Уул','Орхон','Сэлэнгэ','Төв','Хөвсгөл'])[1 + h2 % 6] ELSE 'Улаанбаатар' END,
        CASE WHEN rural THEN NULL ELSE (${DIST})[1 + h2 % 6] END,
        CASE WHEN rural OR h % 13 = 0 THEN NULL ELSE 1 + h2 % 20 END,
        (h % 120 + 1) || '-р байр, ' || (h2 % 90 + 1) || ' тоот' || CASE WHEN h % 5 = 0 THEN ', ' || (ARRAY['Нарны хороолол','Зайсан','10-р хороолол','Энхтайван','Хороолол 3'])[1 + h2 % 5] ELSE '' END,
        CASE WHEN h % 9 = 0 THEN 'Оройн 18 цагаас хойш' END,
        (${pageArr})[1 + h % ${pages.length}], o.id, o.name,
        (ts AT TIME ZONE 'Asia/Ulaanbaatar')::date + 1,
        rural AND st <> 'PENDING_PAYMENT',
        CASE WHEN st NOT IN ('PENDING_PAYMENT') AND NOT (st = 'CANCELLED' AND rural) THEN ts + CASE WHEN rural THEN interval '1 day' ELSE interval '0' END END,
        CASE WHEN rural THEN ts + interval '7 day' END,
        0, 0, 0, 0,
        CASE WHEN st = 'CANCELLED' THEN ((${CAN})[1 + h2 % 6])::"CancelReason" END,
        CASE WHEN st = 'CANCELLED' THEN 'Тест цуцлалт' END,
        CASE WHEN st = 'CANCELLED' THEN ts + interval '3 hour' END,
        CASE WHEN st = 'CANCELLED' THEN o.name END,
        CASE WHEN st = 'DELIVERED' THEN ts + interval '1 day' + (h % 10) * interval '1 hour' END,
        'seed-' || i, ts, ts
      FROM s JOIN _ops o ON o.k = s.h2 % ${nOps}`);
    // Мөр: 1–3 бараа
    await db.$executeRawUnsafe(`
      INSERT INTO "OrderLine" ("orderId","variantId","productId",code,name,label,"listPrice","unitPrice",qty,"discountReason","deliveryIncluded")
      SELECT i, v.id, v."productId", v.code, v.name, v.label, v.price,
        CASE WHEN x.h % 50 = 0 THEN (v.price * 0.9)::int ELSE v.price END, 1 + x.h % 2,
        CASE WHEN x.h % 50 = 0 THEN 'Тест хөнгөлөлт' END, v."deliveryIncluded"
      FROM (SELECT i, n, abs(hashint4(i * 3 + n)) AS h FROM generate_series(${start}, ${end}) i
            CROSS JOIN generate_series(0, 2) n WHERE n <= abs(hashint4(i)) % 3) x
      JOIN _v v ON v.k = x.h % ${nV}
      ON CONFLICT ("orderId","variantId") DO NOTHING`);
    // Дүн
    await db.$executeRawUnsafe(`
      UPDATE "Order" o SET subtotal = t.sub, discount = t.disc,
        "deliveryFee" = CASE WHEN t.fee THEN CASE WHEN o.province = 'Улаанбаатар' THEN 5000 ELSE 10000 END ELSE 0 END,
        total = t.sub - t.disc + CASE WHEN t.fee THEN CASE WHEN o.province = 'Улаанбаатар' THEN 5000 ELSE 10000 END ELSE 0 END
      FROM (SELECT "orderId", sum("listPrice" * qty)::int AS sub, sum(("listPrice" - "unitPrice") * qty)::int AS disc, bool_or(NOT "deliveryIncluded") AS fee
            FROM "OrderLine" WHERE "orderId" BETWEEN ${start} AND ${end} GROUP BY 1) t
      WHERE o.id = t."orderId"`);
    console.log(`  ${end.toLocaleString('en-US')}/${N.toLocaleString('en-US')} (${((Date.now() - t0) / 1000).toFixed(0)} сек)`);
  }
  await db.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"Order"', 'id'), ${N})`);
  await db.$executeRawUnsafe(`SELECT setval('order_number_seq', ${N})`);
  // Идэвхтэй захиалгын нөөц (сүүлийн өдрүүд) — үлдэгдэл хүрэлцэх хэмжээгээр л
  await db.$executeRawUnsafe(`
    INSERT INTO "StockReservation" (ref, "orderId", "variantId", qty)
    SELECT 'order:' || l."orderId", l."orderId", l."variantId", l.qty FROM "OrderLine" l JOIN "Order" o ON o.id = l."orderId"
    WHERE o.status IN ('PENDING_PAYMENT','NEW','ASSIGNED') LIMIT 3000`).catch((e) => console.log('  нөөц алгаслаа:', String(e).slice(0, 120)));
  // Дуудлагын тэмдэглэл ~60,000 (сүүлийн 60 хоног)
  await db.$executeRawUnsafe(`
    INSERT INTO "CallNote" (phone, "variantId", "pageId", status, "ownerId", "ownerName", attempts, "lastAttemptAt", "closeReason", "closedAt", "createdById", "createdAt", "updatedAt")
    SELECT '9' || lpad((h % 10000000)::text, 7, '0'), v.id, (${pageArr})[1 + h % ${pages.length}],
      st::"CallStatus", o.id, o.name, CASE WHEN st = 'PENDING' THEN 0 ELSE 1 + h % 5 END, CASE WHEN st = 'PENDING' THEN NULL ELSE ts + interval '1 hour' END,
      CASE WHEN st = 'CANCELLED' THEN ((ARRAY['NO_ANSWER','PRICE','OUT_OF_STOCK','NO_SIZE_COLOR','DELIVERY','JUST_ASKING','BOUGHT_ELSEWHERE'])[1 + h2 % 7])::"CallCloseReason" END,
      CASE WHEN st IN ('CANCELLED','ORDERED') THEN ts + interval '2 hour' END, o.id, ts, ts
    FROM (SELECT i, abs(hashint4(i + 333)) AS h, abs(hashint4(i + 444)) AS h2, now() - (i::float / 1000) * interval '1 hour' AS ts,
            (ARRAY['PENDING','CONTACTED','ORDERED','ORDERED','CANCELLED','CANCELLED'])[1 + abs(hashint4(i + 555)) % 6] AS st FROM generate_series(1, 60000) i) g
    JOIN _ops o ON o.k = g.h2 % ${nOps} JOIN _v v ON v.k = g.h % ${nV}`);
  await db.$executeRawUnsafe(`
    INSERT INTO "BlacklistEntry" (phone, reason, "reportedBy") SELECT '8' || lpad((abs(hashint4(i)) % 10000000)::text, 7, '0'), 'Тест: захиалга авдаггүй', 'Тест' FROM generate_series(1, 50) i`);
  await db.$executeRawUnsafe('DROP TABLE _ops');
  await db.$executeRawUnsafe('DROP TABLE _v');
  for (const t of ['Order', 'OrderLine', 'CallNote']) await db.$executeRawUnsafe(`ANALYZE "${t}"`);
  const [o, l] = await Promise.all([db.order.count(), db.orderLine.count()]);
  console.log(`Дууслаа: ${o.toLocaleString('en-US')} захиалга, ${l.toLocaleString('en-US')} мөр, ${((Date.now() - t0) / 1000).toFixed(0)} сек.`);
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
