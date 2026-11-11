/** B3/R3 (Модуль 7г): барааны гарц, бүүст, анхааруулгын ХУУРАМЧ өгөгдөл (dev database) */
import { db } from '../lib/db';
import { ubDay, ubDayStart } from '../lib/ubdate';
import { addDays } from '../lib/services/delivery/core';
import * as S from '../lib/services/outflow';
(async () => {
  const act = async (phone: string) => { const u = await db.user.findFirstOrThrow({ where: { phone } }); return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' }; };
  const sa = await act('80000001'); const lead = await act('80000139'); const mk = await act('80000144'); const mk2 = await act('80000140');
  const LONG = 'Зайгүймаашуртүгбайнаадрестэндэхтэйбайраатооттойгуддаар'.repeat(2);
  await S.setOwner(lead, { productIds: [1, 2, 3], userId: mk.id });
  await S.setOwner(lead, { productIds: [4, 5], userId: mk2.id });
  await S.saveNote(mk, { productId: 1, note: `Урт тэмдэглэл: зураг шинэчлэх, үнийг шалгах ${LONG}` });
  // бүүст: 1 — 4 өдрийн өмнөөс (хэвийн), 4 — өнөөдөр 10 цагийн өмнө (шинэ, захиалгагүй байж магадгүй)
  for (const [pid, zones, dollar, at] of [[2, 2, 5, Date.parse(`${addDays(ubDay(), -4)}T09:00:00+08:00`)], [3, 1, 10, Date.parse(`${addDays(ubDay(), -4)}T09:00:00+08:00`)], [1, 3, 15, Date.now() - 10 * 3600_000], [4, 1, 5, ubDayStart(addDays(ubDay(), -1)).getTime()]] as const) {
    await S.saveBoost(mk, { productId: pid, zones, dollar, adNumber: pid });
    await db.boostEvent.updateMany({ where: { productId: pid }, data: { at: new Date(at) } });
    await db.productMarketing.update({ where: { productId: pid }, data: { boostOnAt: new Date(at) } });
  }
  const pages = await db.page.findMany({ take: 4 });
  for (const [i, p] of pages.entries()) await S.setPageOwner(lead, { pageId: p.id, userId: i % 2 ? mk2.id : mk.id });
  const y = addDays(ubDay(), -1);
  await S.saveScore(lead, { userId: mk.id, date: y, score: 8, salaryAmount: 30000, note: `Сайн ажилласан ${LONG}`.slice(0, 200) }).catch((e) => console.log(String(e)));
  await S.claim(mk2, 6).catch(() => null);
  S.bustOutflowCache();
  const al = await S.computeAlerts(true);
  console.log('ok alerts', al.map((a) => `${a.productId}:${a.level}`).join(' '));
  void sa; await db.$disconnect();
})();
