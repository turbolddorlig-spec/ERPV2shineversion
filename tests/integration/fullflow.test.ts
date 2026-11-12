import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/**
 * Бүрэн өдрийн урсгал (бодит ашиглалтын шалгалт): захиалга → банкны төлбөр → хуваарилалт → падаан → хүргэлт / хэсэгчилсэн /
 * жолооч цуцалсан / маргааш / оператор цуцалсан → буцаалт → тооцоо нийлэх → нийлүүлэгч → самбар → цалин.
 * Хуудас бүрийн тоо хоорондоо таарч, үлдэгдэл 0 зөрүү, нөөц алдагдахгүй байх ёстой.
 */
let db: typeof import('@/lib/db').db;
let P: typeof import('@/lib/services/products');
let W: typeof import('@/lib/services/stock/warehouses');
let D: typeof import('@/lib/services/stock/docs');
let V: typeof import('@/lib/services/stock/views');
let O: typeof import('@/lib/services/orders/orders');
let A: typeof import('@/lib/services/orders/admin');
let L: typeof import('@/lib/services/delivery/assign');
let H: typeof import('@/lib/services/delivery/handover');
let DR: typeof import('@/lib/services/delivery/driver');
let G: typeof import('@/lib/services/delivery/goods');
let C: typeof import('@/lib/services/accounting/calc');
let S: typeof import('@/lib/services/accounting/settle');
let B: typeof import('@/lib/services/accounting/bank');
let SP: typeof import('@/lib/services/supplier');
let DASH: typeof import('@/lib/services/dashboard');
let SAL: typeof import('@/lib/services/salary');
let OF: typeof import('@/lib/services/outflow');
let U: typeof import('@/lib/ubdate');

beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  P = await import('@/lib/services/products'); W = await import('@/lib/services/stock/warehouses'); D = await import('@/lib/services/stock/docs');
  V = await import('@/lib/services/stock/views'); O = await import('@/lib/services/orders/orders'); A = await import('@/lib/services/orders/admin');
  L = await import('@/lib/services/delivery/assign'); H = await import('@/lib/services/delivery/handover'); DR = await import('@/lib/services/delivery/driver');
  G = await import('@/lib/services/delivery/goods'); C = await import('@/lib/services/accounting/calc'); S = await import('@/lib/services/accounting/settle');
  B = await import('@/lib/services/accounting/bank'); SP = await import('@/lib/services/supplier'); DASH = await import('@/lib/services/dashboard');
  SAL = await import('@/lib/services/salary'); OF = await import('@/lib/services/outflow'); U = await import('@/lib/ubdate');
});

let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(71000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
const key = () => randomUUID();
let sa: UserActor; let adm: UserActor; let op: UserActor; let olead: UserActor; let lead: UserActor; let wh: UserActor; let acc: UserActor; let drv: UserActor;
let page: number; let v1: number; let v2: number; let vS: number; let prodS: number; let shop: number; let whId: number; let today: string;
let ph = 0;
const ub = (lines: { variantId: number; qty: number }[], over: Record<string, unknown> = {}) => ({
  phone: String(99700000 + ++ph), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Нарны 45-р байр', pageId: page, lines, idemKey: key(), deliveryDate: today, ...over,
});
const recOk = async () => {
  expect((await V.reconcile(sa, { fresh: true })).ok).toBe(true);
  expect(await db.stockBalance.count({ where: { qty: { lt: 0 } } })).toBe(0);
};

beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); adm = await actor(['ADMIN']); op = await actor(['OPERATOR']); olead = await actor(['OPERATOR_LEAD']);
  lead = await actor(['DRIVER_LEAD']); wh = await actor(['WAREHOUSE']); acc = await actor(['ACCOUNTING']); drv = await actor(['DRIVER']);
  page = (await A.savePage(sa, { name: 'Гутал Шоп' })).id;
  const p = await P.createProduct(sa, { code: 'G1', name: 'Гутлын үдээс', price: 10000, sizes: ['S', 'L'] });
  [v1, v2] = p.variants.map((v) => v.id) as [number, number];
  const s = await P.createProduct(sa, { code: 'N1', name: 'Нийлүүлэгчийн цүнх', price: 20000 });
  prodS = s.id; vS = s.variants[0]!.id;
  whId = (await W.createWarehouse(sa, { name: 'Төв агуулах' })).id;
  await D.createReceipt(wh, { warehouseId: whId, lines: [{ variantId: v1, qty: 50 }, { variantId: v2, qty: 50 }, { variantId: vS, qty: 20 }], idemKey: key() });
  shop = (await SP.saveShop(adm, { name: 'Цүнхний дэлгүүр' })).id;
  await SP.assignProduct(adm, { shopId: shop, productId: prodS });
  await SP.saveDeduction(sa, { shopId: shop, productId: prodS, operatorCost: 1000, deliveryCost: 5000, marketingCost: 0, otherCost: 0 });
  await H.setTrusted(acc, { driverId: drv.id, trusted: true });
  today = U.ubDay();
});

describe('Бүрэн өдрийн урсгал — бүх хуудас уялдаатай', () => {
  it('захиалгаас тооцоо нийлэх хүртэл: тоо бүх хуудсанд таарна, үлдэгдэл 0 зөрүү, нөөц алдагдахгүй', async () => {
    // ── 1. Захиалга (оператор) ──
    const o1 = (await O.createOrder(op, ub([{ variantId: v1, qty: 2 }]))).order;               // хүргэнэ, бэлэн
    const o2 = (await O.createOrder(op, ub([{ variantId: vS, qty: 1 }]))).order;               // нийлүүлэгчийн бараа, данс
    const o3 = (await O.createOrder(op, ub([{ variantId: v1, qty: 1 }, { variantId: v2, qty: 1 }]))).order; // хэсэгчилсэн
    const o4 = (await O.createOrder(op, ub([{ variantId: v2, qty: 1 }]))).order;               // жолооч цуцална
    const o5 = (await O.createOrder(op, ub([{ variantId: v1, qty: 1 }]))).order;               // маргааш
    const o6 = (await O.createOrder(op, ub([{ variantId: vS, qty: 1 }]))).order;               // оператор цуцална (хүргэлтэд гарсан)
    const o7 = (await O.createOrder(op, ub([{ variantId: v2, qty: 1 }], { province: 'Увс', district: null, khoroo: null, addressDetail: '' }))).order; // орон нутаг, банкаар
    expect(o7.status).toBe('PENDING_PAYMENT');
    // нөөц: 7 захиалгын бараа
    expect(await db.stockReservation.count()).toBe(8);

    // ── 2. Банкны импорт: «9988-7711» хэлбэртэй утас ──
    const p7 = o7.phone;
    await B.importTransactions(acc, [{ date: new Date(), description: `Utga: ${p7.slice(0, 4)}-${p7.slice(4)} Uvs`, amount: o7.total }], 'CSV');
    const paid7 = await db.order.findUniqueOrThrow({ where: { id: o7.id } });
    expect([paid7.status, paid7.prepaid, paid7.paidAmount]).toEqual(['NEW', true, o7.total]);

    // ── 3. Хуваарилалт → падаан → жолооч хүлээн авна ──
    const ids = [o1, o2, o3, o4, o5, o6, o7].map((o) => o.id);
    await L.assignOrders(lead, { ids, driverId: drv.id });
    const h = await H.createHandover(wh, { driverId: drv.id, date: today, orderIds: ids });
    await H.prepareHandover(wh, h.id);
    for (const i of (await H.handoverDetail(wh, h.id)).items) await H.setCheck(wh, h.id, { variantId: i.variantId, checked: true });
    await H.confirmHandover(wh, h.id);
    await H.setDriverCheck(drv, h.id, { variantId: 'all', checked: true });
    await H.receiveHandover(drv, h.id);
    expect(await db.stockReservation.count()).toBe(0); // бараа жолоочид — нөөц суллагдсан
    await recOk();

    // ── 4. Хүргэлт ──
    await DR.deliverOrder(drv, o1.id, { payment: 'CASH' });
    await DR.deliverOrder(drv, o2.id, { payment: 'BANK' });
    const l3 = await db.orderLine.findFirstOrThrow({ where: { orderId: o3.id, variantId: v1 } });
    const l3b = await db.orderLine.findFirstOrThrow({ where: { orderId: o3.id, variantId: v2 } });
    await DR.deliverOrder(drv, o3.id, { payment: 'CASH', taken: { [l3.id]: 1, [l3b.id]: 0 } });
    await DR.driverCancel(drv, o4.id, { note: 'Утас авахгүй байна' });
    await DR.postponeOrder(drv, o5.id, {});
    await O.cancelOrder(op, o6.id, { reason: 'CUSTOMER_CANCELLED', note: 'Үйлчлүүлэгч утсаар болиулсан' });
    await DR.deliverOrder(drv, o7.id, { payment: 'CASH', note: 'Урьдчилж төлсөн, гардуулав' });
    await recOk();

    // ── 5. Агуулах буцаалт хүлээн авна (жолоочийн гарт буцаах бүх бараа) ──
    const goods = await G.goodsView(drv.id);
    const ret = goods.items.filter((x) => x.returnable > 0).map((x) => ({ variantId: x.variantId, qty: x.returnable }));
    // o3-ийн v2, o4-ийн v2, o5-ийн v1 (маргааш), o6-ийн цүнх
    expect(ret.sort((a, b) => a.variantId - b.variantId)).toEqual([{ variantId: v1, qty: 1 }, { variantId: v2, qty: 2 }, { variantId: vS, qty: 1 }].sort((a, b) => a.variantId - b.variantId));
    await G.receiveReturn(wh, { driverId: drv.id, lines: ret, idemKey: key() });
    expect((await G.goodsView(drv.id)).totals.balance).toBe(0);
    // маргааш болсон захиалгад нөөц дахин тавигдсан
    expect((await db.stockReservation.findMany({ where: { orderId: o5.id } })).map((r) => [r.variantId, r.qty])).toEqual([[v1, 1]]);
    await recOk();

    // ── 6. Нягтлан: жолоочийн өдрийн тооцоо ──
    const day = await C.computeDriverDay(db, today, drv.id);
    const delivered = [o1, o2, o7].reduce((s, o) => s + o.total, 0) + 10000; // o3 хэсэгчилсэн → 10,000
    expect([day.delivered, day.cancelled, day.excluded, day.postponed, day.out]).toEqual([4, 1, 1, 1, 0]);
    expect([day.deliveredAmount, day.prepaidAmount, day.cash, day.bank]).toEqual([delivered, o7.total, o1.total + 10000, o2.total]);
    expect(day.toReceive).toBe(delivered - o7.total - day.salary);
    // гүйцэтгэл: 4 / (4 + 1 цуцалсан + 1 маргааш) — оператор цуцалсныг тоолохгүй
    expect(day.perfCalc).toBe(66.67);
    await S.submitSettlement(drv, { date: today, cash: day.toReceive - o2.total, bank: o2.total, debt: 0 });
    const sid = (await C.computeDriverDay(db, today, drv.id)).settlement!.id;
    expect((await S.approveSettlement(acc, sid)).settlement.status).toBe('COMPLETED');

    // ── 7. Нийлүүлэгч: падааны өдрөөр, авсан тоо ──
    const sday = await SP.dayView(adm, shop, today);
    expect([sday.totals.qty, sday.totals.sales, sday.totals.deductions, sday.totals.net]).toEqual([1, 20000, 6000, 14000]);

    // ── 8. Хянах самбар: захиалгын өдрөөр ──
    DASH.bustDashboard();
    const sm = await DASH.summary(adm, 'day', undefined);
    // 7 захиалга: хүргэсэн 4 (o1,o2,o3,o7), цуцлагдсан o4, o6 + маргааш o5 = 3
    expect([sm.kpi.total, sm.kpi.delivered, sm.kpi.cancelled, sm.kpi.inDelivery, sm.kpi.postponed]).toEqual([7, 4, 3, 0, 1]);
    expect(sm.kpi.successRate + sm.kpi.cancelRate).toBeCloseTo(100, 0);

    // ── 9. Барааны гарц: тэр өдөртөө цуцлагдсан (o4, o6) тоологдохгүй ──
    OF.bustOutflowCache(); OF.bustTable();
    const t = await OF.outflowTable(sa, {});
    const g1 = t.rows.find((r) => r.code === 'G1')!;
    const n1 = t.rows.find((r) => r.code === 'N1')!;
    expect([g1.daily[0], n1.daily[0]]).toEqual([2 + 2 + 1 + 1, 1]); // o1 2, o3 2 (захиалсан тоо), o5 1, o7 1; цүнх o2 1

    // ── 10. Операторын цалин (захиалгаар): хүргэгдсэн 4 ──
    await SAL.setConfig(acc, { staffKey: `u:${op.id}`, salaryType: 'ORDER_BASED', oppRatePerOrder: 1000, bonusSalary: 0 });
    const half = Number(today.slice(8)) <= 15 ? 1 : 2;
    expect((await SAL.prepareSalary(acc, `u:${op.id}`, today.slice(0, 7), half)).auto.orderCount).toBe(4);

    // ── 11. Эцсийн шалгалт: үлдэгдэл, нөөц, түүх ──
    await recOk();
    const left = await db.stockReservation.findMany();
    expect(left.map((r) => r.orderId)).toEqual([o5.id]); // зөвхөн маргааш хүргэх
    expect(await db.auditLog.count({ where: { action: { in: ['order.created', 'order.delivered', 'order.cancelled', 'order.driver_cancelled', 'order.postponed'] } } })).toBeGreaterThanOrEqual(13);
  });
});
