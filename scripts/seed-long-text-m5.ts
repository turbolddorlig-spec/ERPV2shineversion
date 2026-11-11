/**
 * B3/R3 (Модуль 5): жолоочийн апп, буцаалт, асуудлын урт текстийн ХУУРАМЧ өгөгдөл (dev database).
 * seed-long-text.ts-ийн дараа: урт өгөгдлийн падааныг өгч, нэг захиалгад урт асуудал, нэгийг урт шалтгаантай цуцалж (бараа буцаах), нэмэлт бараа.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../lib/db';
import * as H from '../lib/services/delivery/handover';
import * as DR from '../lib/services/delivery/driver';
import * as G from '../lib/services/delivery/goods';
(async () => {
  process.env.DISABLE_JOBS = '1';
  const act = async (phone: string) => { const u = await db.user.findFirstOrThrow({ where: { phone } }); return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' }; };
  const wh = await act('80000132'); const drv = await act('80000099');
  const LONG = 'Зайгүймаашуртүгбайнаадрестэндэхтэйбайраатооттойгуддаар'.repeat(3);
  const long = await db.order.findFirstOrThrow({ where: { phone: '95550000' }, orderBy: { id: 'desc' } });
  if (long.handoverId) {
    const h = await db.handover.findUniqueOrThrow({ where: { id: long.handoverId } });
    if (h.status === 'DRAFT') await H.prepareHandover(wh, h.id);
    const d = await H.handoverDetail(wh, h.id);
    for (const i of d.items) if (!i.checked) await H.setCheck(wh, h.id, { variantId: i.variantId, checked: true });
    if (d.status !== 'HANDED_OVER') await H.confirmHandover(wh, h.id);
  }
  const out = await db.order.findMany({ where: { driverId: drv.id, status: 'OUT_FOR_DELIVERY', id: { not: long.id }, issueStatus: null }, orderBy: { id: 'asc' }, take: 2 });
  if (out[0]) await DR.reportIssue(drv, out[0].id, { type: 'UNCLEAR_ADDRESS', note: `Урт тайлбар: хаяг олдохгүй, утас авахгүй, хашааны хаалга түгжээтэй, хөршөөс асуухад мэдэхгүй гэсэн ${LONG}` });
  if (out[1]) await DR.driverCancel(drv, out[1].id, { note: `Урт шалтгаан: үйлчлүүлэгч өөр газар нүүсэн, утсаа салгасан, дахин залгахад хүлээж авахгүй ${LONG}` });
  const v = await db.orderLine.findFirst({ where: { orderId: long.id } });
  if (v) await G.extraTake(drv, { lines: [{ variantId: v.variantId, qty: 1 }], idemKey: randomUUID(), note: `Урт тэмдэглэл ${LONG}` }).catch((e) => console.log('extra', String(e).slice(0, 100)));
  console.log(JSON.stringify({ issue: out[0]?.number ?? null, cancelled: out[1]?.number ?? null }));
  await db.$disconnect();
})();
