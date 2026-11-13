/**
 * B3/R3 (Модуль 6): нягтлан, жолоочийн «Орлого», «Төлбөр тооцоо», банкны импортын урт текстийн ХУУРАМЧ өгөгдөл (dev database).
 * seed-long-text-m5.ts-ийн дараа: жолооч 80000099-ийн өнөөдрийн падааны захиалгыг хүргэж, урт тайлбартай өр, урьдчилгаа,
 * гараар засах гүйцэтгэл, банкны гүйлгээ (урт утга) нэмнэ.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../lib/db';
import { ubDay } from '../lib/ubdate';
import * as DR from '../lib/services/delivery/driver';
import * as S from '../lib/services/accounting/settle';
import * as DB from '../lib/services/accounting/debts';
import * as B from '../lib/services/accounting/bank';
(async () => {
  process.env.DISABLE_JOBS = '1';
  const act = async (phone: string) => { const u = await db.user.findFirstOrThrow({ where: { phone } }); return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' }; };
  const sa = await act('80000001'); const drv = await act('80000099');
  const LONG = 'Зайгүймаашуртүгбайнаадрестэндэхтэйбайраатооттойгуддаар'.repeat(3);
  const today = ubDay();
  const out = await db.order.findMany({ where: { driverId: drv.id, status: 'OUT_FOR_DELIVERY', issueStatus: null }, orderBy: { id: 'asc' } });
  for (const [i, o] of out.entries()) {
    await DR.deliverOrder(drv, o.id, o.prepaid ? { note: `Урьдчилж төлсөн ${LONG}` } : { payment: i % 2 ? 'UNPAID' : 'CASH', note: i === 0 ? `Урт тэмдэглэл: хаалганы код 1234, гуравдугаар давхар ${LONG}` : undefined }).catch((e) => console.log('deliver', String(e).slice(0, 100)));
  }
  await DB.addDebt(sa, { driverId: drv.id, kind: 'ACCOUNTING_MISMATCH', amount: 125000, orderNumber: '00000001', description: `Урт тайлбар: өмнөх өдрийн тооцоонд бэлэн мөнгө дутсан, жолооч маргааш өгнө гэж амласан ${LONG}` });
  await DB.closeShortagesNow(sa, drv.id);
  await S.createDriverPayment(drv, { kind: 'ADVANCE', date: today, amount: 1_250_000, note: `Урт тайлбар: бензин, засвар, дугуй солих ${LONG}`, idemKey: randomUUID() });
  await S.createDriverPayment(drv, { kind: 'EXTRA', date: today, amount: 45000, note: `Нэмэлт бараа зарсан мөнгө ${LONG}`, idemKey: randomUUID() });
  await S.setPerfOverride(sa, { driverId: drv.id, date: today, value: 95.5, note: `Урт шалтгаан: үйлчлүүлэгч утсаа солисон, жолоочийн буруу биш ${LONG}` }).catch((e) => console.log('perf', String(e).slice(0, 100)));
  // Аудит #148: хуулга файл байхгүй — Gmail-ээр ирсэн мэт (имэйл бүр өөрийн дугаартай)
  const rows = [{ d: `95550000 ${LONG} төлбөр шилжүүлэв`, a: 35000 }, { d: LONG, a: 7000 }, { d: '99119911 Батболдын захиалгын үлдэгдэл, хүргэлтийн төлбөртэй', a: 125000 }];
  console.log(JSON.stringify(await B.importTransactions({ id: sa.id, name: sa.name }, rows.map((r, i) => ({ date: new Date(), description: r.d, amount: r.a, emailMessageId: `seed-m6-${today}-${i}` })), 'GMAIL')));
  await db.$disconnect();
})();
