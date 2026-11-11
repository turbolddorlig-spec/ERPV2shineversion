/** B3/R3 (Модуль 7в): нийлүүлэгчийн урт текстийн ХУУРАМЧ өгөгдөл (dev database) */
import { db } from '../lib/db';
import { addDays } from '../lib/services/delivery/core';
import { ubDay, dateOnly } from '../lib/ubdate';
import * as S from '../lib/services/supplier';
(async () => {
  const act = async (phone: string) => { const u = await db.user.findFirstOrThrow({ where: { phone } }); return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' }; };
  const sa = await act('80000001');
  const LONG = 'Зайгүймаашуртүгбайнаадрестэндэхтэйбайраатооттойгуддаар'.repeat(2);
  await S.setDefaults(sa, { operatorCost: 1000, deliveryCost: 2000, marketingCost: 1500, otherCost: 500, otherNote: `Савлагаа, шошго, уут ${LONG}`.slice(0, 200) });
  let shop = await db.supplierShop.findFirst({ where: { name: { startsWith: 'Урт нэртэй гадны дэлгүүр' } } });
  if (!shop) {
    const { id } = await S.saveShop(sa, { name: `Урт нэртэй гадны дэлгүүр ${LONG}`.slice(0, 120), contactName: `Холбогдох хүн ${LONG}`.slice(0, 120), contactPhone: '99112233' });
    shop = await db.supplierShop.findUniqueOrThrow({ where: { id } });
  }
  const from = addDays(ubDay(), -10);
  for (const pid of [2, 3]) {
    if (!(await db.supplierProduct.findFirst({ where: { productId: pid, toDate: null } }))) await S.assignProduct(sa, { shopId: shop.id, productId: pid, fromDate: from });
    await S.saveDeduction(sa, { shopId: shop.id, productId: pid, operatorCost: 1000, deliveryCost: 2000, marketingCost: 1500, otherCost: 500, otherNote: `Савлагаа ${LONG}`.slice(0, 200) });
  }
  if (!(await db.supplierShop.findFirst({ where: { name: 'Жижиг дэлгүүр' } }))) await S.saveShop(sa, { name: 'Жижиг дэлгүүр', contactName: 'Болд', contactPhone: '88001122' });
  const sup = await db.user.findFirst({ where: { phone: '80000150' } });
  if (sup && !shop.userId) await db.supplierShop.update({ where: { id: shop.id }, data: { userId: sup.id } });
  // урт шалтгаантай буцаалт (жишээ)
  if (!(await db.supplierAdjustment.findFirst({ where: { shopId: shop.id } }))) {
    await db.supplierAdjustment.create({ data: { shopId: shop.id, kind: 'REFUND', sourceDate: dateOnly(addDays(ubDay(), -3)), orderNumber: '00012345', productId: 2, productName: `Урт нэртэй бараа ${LONG}`, qty: 2, sales: 40000, deduction: 10000, amount: -30000,
      reason: `00012345 — «Урт нэртэй бараа ${LONG}» 2 ширхэгийг шилжүүлсний дараа буцаасан (цуцалсан эсвэл үйлчлүүлэгч аваагүй). Тэр үед олгосон 40,000₮ борлуулалтаас суутгал 10,000₮-ийг хасаад 30,000₮ буцааж тооцно.` } });
  }
  console.log('ok', shop.id); await db.$disconnect();
})();
