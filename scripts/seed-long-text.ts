/**
 * B3/R3: урт текстийн шалгалтын ХУУРАМЧ өгөгдөл (dev database). 300+ тэмдэгт хаяг, тасралтгүй урт үг, урт бараа нэр/тайлбар,
 * 12 мөртэй захиалга, урт дуудлага, хар жагсаалт, падаан. Дараа нь: npm run test:ui (tests/ui/overflow.ts).
 */
import { db } from '../lib/db';
import { createOrder } from '../lib/services/orders/orders';
import { createCallNotes } from '../lib/services/orders/calls';
import { addBlacklist } from '../lib/services/orders/admin';
import { assignOrders } from '../lib/services/delivery/assign';
import { createHandover, setTrusted } from '../lib/services/delivery/handover';
(async () => {
  process.env.DISABLE_JOBS = '1';
  if (await db.order.findFirst({ where: { phone: '95550000', status: { not: 'CANCELLED' } } })) { console.log('Урт өгөгдөл аль хэдийн байна'); await db.$disconnect(); return; }
  const act = async (phone: string) => { const u = await db.user.findFirstOrThrow({ where: { phone } }); return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' }; };
  const sa = await act('80000001'); const op = await act('80000015'); const lead = await act('80000026'); const wh = await act('80000132');
  const LONGWORD = 'Зайгүймаашуртүгбайнаадрестэндэхтэйбайраатооттойгуддаар'.repeat(4);
  const vs = await db.$queryRaw<{ id: number; productId: number }[]>`SELECT v.id, v."productId" FROM "ProductVariant" v JOIN "Product" p ON p.id=v."productId"
    WHERE p.status='ACTIVE' AND (SELECT COALESCE(sum(b.qty),0) FROM "StockBalance" b JOIN "StockLocation" l ON l.id=b."locationId" AND l.kind='WAREHOUSE' AND l."warehouseId"=(SELECT id FROM "Warehouse" WHERE "isPrimary") WHERE b."variantId"=v.id)
      - (SELECT COALESCE(sum(r.qty),0) FROM "StockReservation" r WHERE r."variantId"=v.id) > 3 ORDER BY v.id LIMIT 12`;
  await db.product.update({ where: { id: vs[0]!.productId }, data: {
    name: 'Маш урт нэртэй бараа: эмэгтэй хүний өвлийн дулаан ноосон пальто, хоёр талт, капюшонтой, бүсэлхийн оосортой, том халаастай загвар 2026',
    description: `Урт тайлбар: ${'материал 100% ноос, Солонгосоос ирсэн, угаалгын машинд угааж болохгүй, хими цэвэрлэгээ. '.repeat(5)} ${LONGWORD}` } });
  const page = await db.page.findFirstOrThrow({ where: { isActive: true } });
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const r = await createOrder(op, {
    phone: '95550000', extraPhone: '95550009', province: 'Улаанбаатар', district: 'Сонгинохайрхан', khoroo: 32,
    addressDetail: `Толгойт, 21-р хороолол, Минж хотхон, 115 дугаар байр, 3-р орц, 12 давхар, 1205 тоот, орцны код 1205#, хаалганы хонх ажиллахгүй тул утсаар залгана уу, жижүүрт үлдээж болохгүй ${LONGWORD}`,
    note: `Оператор санамж: үйлчлүүлэгч орой 18:00-20:00 цагийн хооронд л гэртээ байна, өмнө нь залгаж байгаад очно уу, хүүхэд унтаж байгаа тул хаалга тогшихгүй ${LONGWORD}`,
    pageId: page.id, deliveryDate: today, lines: vs.map((v) => ({ variantId: v.id, qty: 1 })), idemKey: `long-${Date.now()}`,
  });
  await createCallNotes(op, { phones: '95550002', productText: `Маш урт бараа ${LONGWORD}`.slice(0, 120), note: `Урт тэмдэглэл ${'үйлчлүүлэгч дахин залгана гэсэн, '.repeat(8)}${LONGWORD}`.slice(0, 500) });
  await addBlacklist(sa, { phone: '95550001', reason: `Урт шалтгаан: ${'өмнө нь 3 удаа захиалаад авахгүй буцаасан, утсаа салгасан, '.repeat(4)}${LONGWORD}` });
  const drv = await db.user.findFirstOrThrow({ where: { phone: '80000099' } });
  await setTrusted(sa, { driverId: drv.id, trusted: true });
  await assignOrders(lead, { ids: [r.order.id], driverId: drv.id });
  const h = await createHandover(wh, { driverId: drv.id, date: today, orderIds: (await db.order.findMany({ where: { driverId: drv.id, deliveryDate: new Date(today + 'T00:00:00Z'), status: 'ASSIGNED', handoverId: null }, select: { id: true } })).map((o) => o.id) }).catch((e) => { console.log('handover', String(e).slice(0, 120)); return null; });
  console.log(JSON.stringify({ orderId: r.order.id, number: r.order.number, productId: vs[0]!.productId, driverId: drv.id, handoverId: h?.id ?? null, today }));
  await db.$disconnect();
})();
