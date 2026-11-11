/** B3/R3 (Модуль 7а): торгуулийн урт текстийн ХУУРАМЧ өгөгдөл (dev database) */
import { db } from '../lib/db';
import * as PN from '../lib/services/penalties';
(async () => {
  const act = async (phone: string) => { const u = await db.user.findFirstOrThrow({ where: { phone } }); return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' }; };
  const sa = await act('80000001'); const op = await act('80000006'); const drv = await act('80000099');
  const LONG = 'Зайгүймаашуртүгбайнаадрестэндэхтэйбайраатооттойгуддаар'.repeat(2);
  const c = await PN.saveCategory(sa, { type: 'OPP_ERROR', name: `Урт нэртэй алдаа ${LONG}`.slice(0, 80), defaultAmount: 5000 }).catch(() => null);
  await PN.createPenalty(sa, { userId: op.id, categoryId: c?.id, customName: c ? undefined : 'Урт алдаа', amount: 125000, description: `Урт тайлбар: үйлчлүүлэгчийн коммент шүүгээгүй, дугаар үлдээсэн ${LONG}`, pageName: `Маш урт нэртэй пэйж ${LONG}`, customerPhone: '95550000', customerName: `Урт нэр ${LONG}` });
  const p = await PN.createPenalty(sa, { userId: drv.id, customName: 'Хоцролт', amount: 5000, lateMinutes: 45 });
  await PN.cancelPenalty(sa, p.id, { note: `Урт шалтгаан: буруу хүнд тавьсан ${LONG}` });
  console.log('ok');
  await db.$disconnect();
})();
