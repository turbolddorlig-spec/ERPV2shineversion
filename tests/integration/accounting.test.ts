import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/**
 * Модуль 6 — нягтлан: падааны өдрөөр тооцоо (#83), цалин (хуучин хүснэгт + тохиргоо), тооцоо нийлэх, түгжээ, төлөв солих,
 * автомат дутуу барааны өр, урьдчилгаа, банкны импорт. Үлдэгдэл бүх замд 0 зөрүү (B2).
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
let U: typeof import('@/lib/ubdate');
let DR: typeof import('@/lib/services/delivery/driver');
let G: typeof import('@/lib/services/delivery/goods');
let C: typeof import('@/lib/services/accounting/calc');
let S: typeof import('@/lib/services/accounting/settle');
let DB: typeof import('@/lib/services/accounting/debts');
let B: typeof import('@/lib/services/accounting/bank');
let GM: typeof import('@/lib/services/accounting/gmail');

beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  P = await import('@/lib/services/products');
  W = await import('@/lib/services/stock/warehouses');
  D = await import('@/lib/services/stock/docs');
  V = await import('@/lib/services/stock/views');
  O = await import('@/lib/services/orders/orders');
  A = await import('@/lib/services/orders/admin');
  L = await import('@/lib/services/delivery/assign');
  H = await import('@/lib/services/delivery/handover');
  U = await import('@/lib/ubdate');
  DR = await import('@/lib/services/delivery/driver');
  G = await import('@/lib/services/delivery/goods');
  C = await import('@/lib/services/accounting/calc');
  S = await import('@/lib/services/accounting/settle');
  DB = await import('@/lib/services/accounting/debts');
  B = await import('@/lib/services/accounting/bank');
  GM = await import('@/lib/services/accounting/gmail');
});

let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(76000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
async function err(p: Promise<unknown>, status: number, code?: string): Promise<AppError> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(status);
    if (code) expect((e as AppError).code).toBe(code);
    return e as AppError;
  }
  throw new Error(`Алдаа гарах ёстой байсан (${status})`);
}
const key = () => randomUUID();

let sa: UserActor; let op: UserActor; let olead: UserActor; let lead: UserActor; let wh: UserActor; let acc: UserActor; let drv: UserActor; let drv2: UserActor;
let page1: number; let v1: number; let v2: number; let mainWh: number;
let today: string; let tomorrow: string;
let phoneSeq = 0;
const ub = (over: Record<string, unknown> = {}) => ({
  phone: String(99100000 + ++phoneSeq), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Тест 45-р байр',
  pageId: page1, lines: [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 1 }], idemKey: key(), ...over,
});
const TOTAL = 30000; // 2×10000 + 1×10000 (хүргэлт барааны үнэд багтсан)
async function checkAll(id: number) {
  const d = await H.handoverDetail(wh, id);
  for (const i of d.items) await H.setCheck(wh, id, { variantId: i.variantId, checked: true });
}
async function handTo(driver: UserActor, date: string, ids: number[]) {
  const h = await H.createHandover(wh, { driverId: driver.id, date, orderIds: ids });
  await H.prepareHandover(wh, h.id); await checkAll(h.id); await H.confirmHandover(wh, h.id);
  await H.setDriverCheck(driver, h.id, { variantId: 'all', checked: true }); await H.receiveHandover(driver, h.id);
  return h.id;
}
async function outFor(driver: UserActor, n = 1, over: Record<string, unknown> = {}) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push((await O.createOrder(op, ub({ deliveryDate: today, ...over }))).order.id);
  await L.assignOrders(lead, { ids, driverId: driver.id });
  await handTo(driver, today, ids);
  return ids;
}
const recOk = async () => {
  const r = await V.reconcile(sa, { fresh: true });
  expect(r.ok).toBe(true);
  expect(await db.stockBalance.count({ where: { qty: { lt: 0 } } })).toBe(0);
};
const row = async (u: UserActor, date = today) => C.computeDriverDay(db, date, u.id);
const lineOf = async (orderId: number, variantId: number) => (await db.orderLine.findFirstOrThrow({ where: { orderId, variantId } })).id;

beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); op = await actor(['OPERATOR']); olead = await actor(['OPERATOR_LEAD']); lead = await actor(['DRIVER_LEAD']); wh = await actor(['WAREHOUSE']);
  acc = await actor(['ACCOUNTING']); drv = await actor(['DRIVER']); drv2 = await actor(['DRIVER']);
  page1 = (await A.savePage(sa, { name: 'Гутал Шоп' })).id;
  const p = await P.createProduct(sa, { code: 'G1', name: 'Гутлын үдээс', price: 10000, sizes: ['S', 'L'] });
  [v1, v2] = p.variants.map((v) => v.id) as [number, number];
  mainWh = (await W.createWarehouse(sa, { name: 'Төв агуулах' })).id;
  await D.createReceipt(wh, { warehouseId: mainWh, lines: [{ variantId: v1, qty: 60 }, { variantId: v2, qty: 30 }], idemKey: key() });
  today = U.ubDay(); tomorrow = U.ubDay(new Date(), 1);
  await H.setTrusted(acc, { driverId: drv.id, trusted: true });
  await H.setTrusted(acc, { driverId: drv2.id, trusted: true });
});

describe('цалин — хуучин хүснэгт яг ижил', () => {
  it('rateFor: орон нутаг → тусгай → гараар → 35+ → 35-аас цөөн', () => {
    const R = C.DEFAULT_RULES; const N = { mode: 'NORMAL' as const, regionalRate: null };
    expect(C.rateFor(R, { mode: 'REGIONAL', regionalRate: null }, 10, 5, false)).toEqual({ rate: 3000, tier: 'regional' });
    expect(C.rateFor(R, { mode: 'REGIONAL', regionalRate: 3500 }, 100, 50, true).rate).toBe(3500);
    expect(C.rateFor(R, { mode: 'SPECIAL', regionalRate: null }, 91.5, 5, false).rate).toBe(5000);
    expect(C.rateFor(R, { mode: 'SPECIAL', regionalRate: null }, 86.4, 5, false).rate).toBe(4500);
    expect(C.rateFor(R, { mode: 'SPECIAL', regionalRate: null }, 86.3, 5, false).rate).toBe(4000);
    expect(C.rateFor(R, N, 94.5, 3, true)).toEqual({ rate: 5000, tier: 'manual' });
    expect(C.rateFor(R, N, 89.5, 3, true).rate).toBe(4500);
    expect(C.rateFor(R, N, 94.5, 35, false)).toEqual({ rate: 5000, tier: 'big' });
    expect(C.rateFor(R, N, 94.4, 35, false).rate).toBe(4500);
    expect(C.rateFor(R, N, 89.4, 40, false).rate).toBe(4000);
    expect(C.rateFor(R, N, 100, 34, false)).toEqual({ rate: 5000, tier: 'small' });
    expect(C.rateFor(R, N, 99.9, 34, false).rate).toBe(4500);
    expect(C.rateFor(R, N, 90, 10, false).rate).toBe(4500);
    expect(C.rateFor(R, N, 89.9, 10, false).rate).toBe(4000);
  });
});

describe('падааны өдрөөр тооцоо (#83)', () => {
  it('хүргэсэн (Бэлэн/Данс/Төлөөгүй), цуцалсан, маргааш → гүйцэтгэл, хөлс, хүлээн авах; жолооч ба нягтлан ижил тоо', async () => {
    const [a, b, c, d, e] = await outFor(drv, 5);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await DR.deliverOrder(drv, b!, { payment: 'BANK' });
    await DR.deliverOrder(drv, c!, { payment: 'UNPAID' });
    await DR.driverCancel(drv, d!, { note: 'Үйлчлүүлэгч авахгүй гэсэн' });
    await DR.postponeOrder(drv, e!, {});
    const r = await row(drv);
    expect([r.total, r.delivered, r.cancelled, r.postponed, r.out, r.countable]).toEqual([5, 3, 1, 1, 0, 5]);
    expect([r.perfCalc, r.rate, r.tier, r.salary]).toEqual([60, 4000, 'small', 12000]);
    expect([r.deliveredAmount, r.cash, r.bank, r.unpaid, r.toReceive]).toEqual([3 * TOTAL, TOTAL, TOTAL, TOTAL, 3 * TOTAL - 12000]);
    const board = await S.accountingDay(acc, today);
    const income = await S.driverIncome(drv, today);
    expect(board.items.find((x) => x.driverId === drv.id)).toEqual(income.day);
    expect(board.kpi.toReceive).toBe(r.toReceive);
    await err(S.accountingDay(drv, today), 403);
    await err(S.driverIncome(acc, today), 403);
    await recOk();
  });

  it('хэсэгчилсэн хүргэлт: дүн буурч хүлээн авах зөв (#73); урьдчилж төлсөн хасагдана', async () => {
    const pre = (await O.createOrder(op, ub({ deliveryDate: today, prepaidWait: true }))).order.id;
    await O.markPaid(olead, pre);
    const [a] = await outFor(drv, 1);
    await L.assignOrders(lead, { ids: [pre], driverId: drv.id });
    const h2 = await db.handover.findFirstOrThrow({ where: { driverId: drv.id } });
    expect(h2).toBeTruthy();
    // Өнөөдрийн падаан өгөгдсөн → pre маргаашийн падаанд
    const preO = await db.order.findUniqueOrThrow({ where: { id: pre } });
    await handTo(drv, U.ymdOf(preO.deliveryDate), [pre]);
    await DR.deliverOrder(drv, a!, { payment: 'CASH', taken: { [await lineOf(a!, v1)]: 1 } });
    await DR.deliverOrder(drv, pre, { note: 'Урьдчилж төлсөн, бараа өгсөн' });
    const r = await row(drv);
    expect([r.delivered, r.deliveredAmount, r.partialCount, r.refusedAmount]).toEqual([1, TOTAL - 10000, 1, 10000]);
    expect([r.rate, r.toReceive]).toEqual([5000, TOTAL - 10000 - 5000]); // 100%, 35-аас цөөн → 5000
    const r2 = await row(drv, U.ymdOf(preO.deliveryDate));
    expect([r2.delivered, r2.prepaidAmount, r2.prepaidCount, r2.toReceive]).toEqual([1, TOTAL, 1, -5000]);
    await recOk();
  });

  it('«Маргааш» → дараагийн өдрийн падаанд хүргэсэн: өдөр бүрт нэг л удаа, шөнө дундаас хойш хүргэсэн ч падааны өдөрт', async () => {
    const [a, b] = await outFor(drv, 2);
    await DR.postponeOrder(drv, b!, {});
    await G.receiveReturn(wh, { driverId: drv.id, lines: [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 1 }], idemKey: key() });
    await L.assignOrders(lead, { ids: [b!], driverId: drv2.id });
    await handTo(drv2, tomorrow, [b!]);
    await DR.deliverOrder(drv2, b!, { payment: 'CASH' });
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    // Хүргэсэн мөчийг маргааш болгож (шөнө дундаас хойш) — тооцоо падааны өдөрт хэвээр
    await db.order.update({ where: { id: a! }, data: { deliveredAt: U.ubDayStart(tomorrow) } });
    const d1 = await row(drv);
    expect([d1.total, d1.delivered, d1.postponed, d1.perfCalc]).toEqual([2, 1, 1, 50]);
    const d2 = await row(drv2, tomorrow);
    expect([d2.total, d2.delivered, d2.postponed]).toEqual([1, 1, 0]);
    expect((await row(drv2)).total).toBe(0);
    await recOk();
  });

  it('асуудлаар цуцлалт: опп / маркетинг / агуулахын алдаа гүйцэтгэлээс хасагдана, жолоочийн алдаа цуцалсанд', async () => {
    const [a, b, c] = await outFor(drv, 3);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await DR.reportIssue(drv, b!, { type: 'WRONG_NUMBER' });
    await DR.resolveIssue(olead, b!, { action: 'cancel', note: 'Утас буруу авсан', fault: 'OPERATOR' });
    await DR.reportIssue(drv, c!, { type: 'UNCLEAR_ADDRESS' });
    await DR.resolveIssue(olead, c!, { action: 'cancel', note: 'Жолооч хаяг олоогүй', fault: 'DRIVER' });
    const r = await row(drv);
    expect([r.delivered, r.cancelled, r.excluded, r.countable, r.perfCalc]).toEqual([1, 1, 1, 2, 50]);
  });
});

describe('#124 ялгаа 1: хүргэлтэд гарсныг оператор цуцлах (хуучин шиг)', () => {
  it('цуцлагдана; бараа жолоочид үлдэж агуулахад буцна; жолоочийн гүйцэтгэлд тоологдохгүй; дараа нь жолооч хүргэж чадахгүй', async () => {
    const [a, b] = await outFor(drv, 2);
    await O.cancelOrder(op, a!, { reason: 'CUSTOMER_CANCELLED', note: 'Үйлчлүүлэгч утсаар болиулсан' });
    const o = await db.order.findUniqueOrThrow({ where: { id: a! } });
    expect([o.status, o.issueFault, o.cancelNote?.startsWith('Оператор цуцалсан')]).toEqual(['CANCELLED', 'OPERATOR', true]);
    await err(DR.deliverOrder(drv, a!, { payment: 'CASH' }), 409);
    await DR.deliverOrder(drv, b!, { payment: 'CASH' });
    const r = await row(drv);
    expect([r.delivered, r.cancelled, r.excluded, r.perfCalc]).toEqual([1, 0, 1, 100]);
    // бараа жолоочид — агуулах буцаалтаар авна, журнал зөв
    const back = await db.orderLine.findMany({ where: { orderId: a! } });
    await G.receiveReturn(wh, { driverId: drv.id, lines: back.map((l) => ({ variantId: l.variantId, qty: l.qty })), idemKey: key() });
    await recOk();
  });
});

describe('тооцоо нийлэх, түгжээ', () => {
  it('#124-7: баталгаажуулах ба «Төлөв солих» зэрэг ирвэл түгжигдсэн өдөрт буруу дүн үлдэхгүй', async () => {
    const [a, b] = await outFor(drv, 2);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await DR.deliverOrder(drv, b!, { payment: 'CASH' });
    const total = (await row(drv)).toReceive;
    await S.submitSettlement(drv, { date: today, cash: total });
    const sid = (await row(drv)).settlement!.id;
    const [ap, tg] = await Promise.allSettled([
      S.approveSettlement(acc, sid),
      S.toggleOrderStatus(acc, b!, { target: 'CANCELLED', note: 'Үйлчлүүлэгч буцаасан' }),
    ]);
    const st = await db.driverSettlement.findUniqueOrThrow({ where: { id: sid } });
    const ob = await db.order.findUniqueOrThrow({ where: { id: b! } });
    if (st.status === 'COMPLETED') {
      // баталгаажуулалт түрүүлсэн → төлөв солих түгжээнд саатна, захиалга хүргэсэн хэвээр, snapshot дүн = бодит
      expect(tg.status).toBe('rejected');
      expect(ob.status).toBe('DELIVERED');
    } else {
      // төлөв солих түрүүлсэн → баталгаажуулалт шинэ дүнгээр зөрүү илрүүлнэ (түгжигдэхгүй)
      expect(ob.status).toBe('CANCELLED');
      expect(ap.status === 'rejected' || (ap.status === 'fulfilled' && !ap.value)).toBe(true);
    }
    await recOk();
  });

  it('дуусаагүй бол илгээхгүй; Бэлэн+Данс+Өр = Авах дүн; илгээсний дараа жолооч өөрчлөхгүй; буцаах; баталгаажуулах → түгжээ, өр', async () => {
    const [a, b] = await outFor(drv, 2);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await err(S.submitSettlement(drv, { date: today, cash: 0 }), 409, 'unfinished');
    await DR.deliverOrder(drv, b!, { payment: 'BANK' });
    const r = await row(drv);
    expect(r.toReceive).toBe(2 * TOTAL - 10000);
    await err(S.submitSettlement(drv, { date: today, cash: 1, bank: TOTAL, debt: 0 }), 400, 'sum_mismatch');
    await err(S.submitSettlement(acc, { date: today }), 403);
    await S.submitSettlement(drv, { date: today, cash: TOTAL - 20000, bank: TOTAL, debt: 10000 });
    expect((await row(drv)).settlement?.status).toBe('PENDING');
    await err(DR.undoDelivery(drv, a!, { note: 'Андуурч дарсан байна' }), 409, 'day_submitted');
    await S.withdrawSettlement(drv, { date: today });
    await S.submitSettlement(drv, { date: today, cash: TOTAL - 20000, bank: TOTAL, debt: 10000 });
    const sid = (await row(drv)).settlement!.id;
    await err(S.approveSettlement(drv, sid), 403);
    const ap = await S.approveSettlement(acc, sid);
    expect(ap.settlement.status).toBe('COMPLETED');
    expect((await S.approveSettlement(acc, sid)).duplicate).toBe(true);
    const debts = await db.companyDebt.findMany({ where: { driverId: drv.id } });
    expect(debts.map((d) => [d.kind, d.amount, d.status])).toEqual([['SETTLEMENT_DEBT', 10000, 'PENDING']]);
    // Түгжээ
    await err(DR.undoDelivery(drv, a!, { note: 'Андуурч дарсан байна' }), 409, 'day_locked');
    await err(S.toggleOrderStatus(acc, a!, { target: 'CANCELLED', note: 'Үйлчлүүлэгч буцаасан' }), 409, 'day_locked');
    await err(S.setPerfOverride(acc, { driverId: drv.id, date: today, value: 50, note: 'Шалгаж үзье' }), 409, 'day_locked');
    await err(S.withdrawSettlement(drv, { date: today }), 409, 'day_locked');
    await err(H.revertHandover(wh, (await db.handover.findFirstOrThrow({ where: { driverId: drv.id } })).id), 409);
    // Хуулбар: горим солигдсон ч баталгаажсан өдрийн тоо өөрчлөгдөхгүй
    await db.driverPayMode.create({ data: { driverId: drv.id, effectiveFrom: U.dateOnly(today), mode: 'REGIONAL', regionalRate: 1000, byName: 'тест' } });
    const locked = await row(drv);
    expect([locked.locked, locked.toReceive, locked.rate]).toEqual([true, r.toReceive, 5000]);
    await recOk();
  });

  it('илгээсний дараа нягтлан тоо өөрчилбөл тооцоо ноорог болж, жолооч дахин илгээнэ; гараар засах гүйцэтгэл', async () => {
    const [a, b] = await outFor(drv, 2);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await DR.driverCancel(drv, b!, { note: 'Үйлчлүүлэгч болисон' });
    expect([(await row(drv)).perfCalc, (await row(drv)).rate]).toEqual([50, 4000]);
    await S.submitSettlement(drv, { date: today, cash: TOTAL - 4000 });
    await err(S.setPerfOverride(acc, { driverId: drv.id, date: today, value: 95 }), 400, 'reason_required');
    await err(S.setPerfOverride(acc, { driverId: drv.id, date: today, value: 101, note: 'буруу утга' }), 400);
    const x = await S.setPerfOverride(acc, { driverId: drv.id, date: today, value: 95, note: 'Үйлчлүүлэгчийн буруу' });
    expect([x.day.perf, x.day.perfCalc, x.day.rate, x.day.tier, x.day.toReceive, x.day.settlement?.status]).toEqual([95, 50, 5000, 'manual', TOTAL - 5000, 'DRAFT']);
    await S.submitSettlement(drv, { date: today, cash: TOTAL - 5000 });
    // Нягтлан төлөв сольсон → ноорог (дахин илгээнэ)
    await S.toggleOrderStatus(acc, b!, { target: 'DELIVERED', payment: 'CASH', note: 'Үнэндээ хүргэсэн' });
    const r = await row(drv);
    expect([r.delivered, r.settlement?.status]).toEqual([2, 'DRAFT']);
    await err(S.approveSettlement(acc, r.settlement!.id), 409, 'not_submitted');
    await S.setPerfOverride(acc, { driverId: drv.id, date: today, value: null });
    expect((await row(drv)).perfOverride).toBe(null);
    await recOk();
  });

  it('нягтлангийн «Төлөв солих»: 4 зам, бараа журналаар (жолооч ↔ үйлчлүүлэгч), агуулахад буцаасан бол хүргэсэн болгохгүй', async () => {
    const [a, b, c] = await outFor(drv, 3);
    await err(S.toggleOrderStatus(op, a!, { target: 'DELIVERED', note: 'Хүргэсэн байна' }), 403);
    await err(S.toggleOrderStatus(acc, a!, { target: 'DELIVERED', note: 'x' }), 400, 'reason_required');
    await S.toggleOrderStatus(acc, a!, { target: 'DELIVERED', payment: 'BANK', note: 'Жолооч дарахаа мартсан' });
    let o = await db.order.findUniqueOrThrow({ where: { id: a! } });
    expect([o.status, o.deliveryPayment, o.deliveredByName]).toEqual(['DELIVERED', 'BANK', `${acc.name} (нягтлан)`]);
    await S.toggleOrderStatus(acc, a!, { target: 'CANCELLED', note: 'Үйлчлүүлэгч буцаасан' });
    o = await db.order.findUniqueOrThrow({ where: { id: a! } });
    expect(o.status).toBe('CANCELLED');
    await S.toggleOrderStatus(acc, a!, { target: 'DELIVERED', payment: 'CASH', note: 'Дахин авсан' });
    await S.toggleOrderStatus(acc, b!, { target: 'CANCELLED', note: 'Утас авахгүй байна' });
    await G.receiveReturn(wh, { driverId: drv.id, lines: [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 1 }], idemKey: key() });
    await err(S.toggleOrderStatus(acc, b!, { target: 'DELIVERED', note: 'Хүргэсэн гэнэ' }), 409, 'goods_not_with_driver');
    await DR.deliverOrder(drv, c!, { payment: 'CASH' });
    const r = await row(drv);
    expect([r.delivered, r.cancelled]).toEqual([2, 1]);
    await recOk();
  });
});

describe('Супер админ: горим ба цалингийн дүрэм (өнгөрсөн өдөр өөрчлөгдөхгүй)', () => {
  it('тусгай / орон нутаг — өнөөдрөөс; зөвхөн Супер админ', async () => {
    const [a] = await outFor(drv, 1);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await err(S.setPayMode(acc, { driverId: drv.id, mode: 'SPECIAL' }), 403);
    await err(S.setPayMode(sa, { driverId: drv.id, mode: 'REGIONAL', rate: 500 }), 400);
    await S.setPayMode(sa, { driverId: drv.id, mode: 'REGIONAL', rate: 3500 });
    expect([(await row(drv)).rate, (await row(drv)).tier]).toEqual([3500, 'regional']);
    await S.setPayMode(sa, { driverId: drv.id, mode: 'SPECIAL' });
    expect((await row(drv)).rate).toBe(5000);
    expect((await S.payModes(sa)).items.find((x) => x.id === drv.id)?.mode).toBe('SPECIAL');
    // Өчигдрийн горим хэвээр (өнөөдрөөс л хүчинтэй)
    expect((await C.modesFor(db, [drv.id], U.ubDay(new Date(), -1))).get(drv.id)).toBe(undefined);
  });

  it('хөлс, босго тохиргоо: маргаашаас; өнөөдөр хэвээр; өнгөрсөн өдөр болохгүй; баталгаажсан өдрөөс хойш болохгүй', async () => {
    const rules = { ...C.DEFAULT_RULES, rates: { high: 6000, mid: 5500, low: 5000 } };
    await err(S.setSalaryRules(acc, { effectiveFrom: tomorrow, rules }), 403);
    await err(S.setSalaryRules(sa, { effectiveFrom: U.ubDay(new Date(), -1), rules }), 400, 'past_date');
    await err(S.setSalaryRules(sa, { effectiveFrom: tomorrow, rules: { ...rules, big: { high: 80, mid: 90 } } }), 400);
    await S.setSalaryRules(sa, { effectiveFrom: tomorrow, rules, note: 'Шатахуун үнэ өссөн' });
    expect((await C.rulesFor(db, today)).rates.high).toBe(5000);
    expect((await C.rulesFor(db, tomorrow)).rates).toEqual({ high: 6000, mid: 5500, low: 5000 });
    const [a] = await outFor(drv, 1);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await S.submitSettlement(drv, { date: today, cash: TOTAL - 5000 });
    await S.approveSettlement(acc, (await row(drv)).settlement!.id);
    await err(S.setSalaryRules(sa, { effectiveFrom: today, rules }), 409, 'day_locked');
  });
});

describe('автомат дутуу барааны өр (#82 6)', () => {
  it('өдрийн эцэст буцаагаагүй бараа → өр (системийн үнээр); буцаахад буурч, бүгдийг буцаахад автоматаар хаагдана; журнал хөдлөхгүй', async () => {
    const [a, b] = await outFor(drv, 2);
    await DR.driverCancel(drv, a!, { note: 'Үйлчлүүлэгч болисон' });
    // b хүргэлтэд хэвээр (held) — өр болохгүй
    const movesBefore = await db.stockMove.count();
    await DB.closeShortagesNow(acc, drv.id);
    let debts = await db.companyDebt.findMany({ where: { driverId: drv.id, status: 'PENDING' }, orderBy: { variantId: 'asc' } });
    expect(debts.map((d) => [d.variantId, d.qty, d.amount])).toEqual([[v1, 2, 20000], [v2, 1, 10000]]);
    expect(await db.stockMove.count()).toBe(movesBefore);
    // Дахин бодоход давхардахгүй
    await DB.closeShortagesNow(acc, drv.id);
    expect(await db.companyDebt.count({ where: { driverId: drv.id, status: 'PENDING' } })).toBe(2);
    // Хэсэгчлэн буцаалт → буурна
    await G.receiveReturn(wh, { driverId: drv.id, lines: [{ variantId: v1, qty: 1 }], idemKey: key() });
    debts = await db.companyDebt.findMany({ where: { driverId: drv.id, status: 'PENDING' }, orderBy: { variantId: 'asc' } });
    expect(debts.map((d) => [d.variantId, d.qty, d.amount])).toEqual([[v1, 1, 10000], [v2, 1, 10000]]);
    await G.receiveReturn(wh, { driverId: drv.id, lines: [{ variantId: v1, qty: 1 }, { variantId: v2, qty: 1 }], idemKey: key() });
    expect(await db.companyDebt.count({ where: { driverId: drv.id, status: 'PENDING' } })).toBe(0);
    const closed = await db.companyDebt.findMany({ where: { driverId: drv.id, status: 'RESOLVED' } });
    expect(closed.every((d) => d.resolvedByName === 'Автомат')).toBe(true);
    await DR.deliverOrder(drv, b!, { payment: 'CASH' });
    await recOk();
  });

  it('өдөрт нэг удаа (арын ажил); нэмэлт бараа зарахад ч өр хаагдана', async () => {
    const [a] = await outFor(drv, 1);
    await DR.driverCancel(drv, a!, { note: 'Үйлчлүүлэгч болисон' });
    const r1 = await DB.closeDayShortages();
    expect(r1.ran).toBe(true);
    expect(r1.created).toBe(2);
    expect((await DB.closeDayShortages()).ran).toBe(false);
    await G.extraSale(drv, { lines: [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 1 }], payment: 'CASH', idemKey: key() });
    expect(await db.companyDebt.count({ where: { driverId: drv.id, status: 'PENDING' } })).toBe(0);
    await recOk();
  });

  it('гараар өр нэмэх / хасах; жолооч өөрийнхөө бүртгэлийг л харна', async () => {
    await err(DB.addDebt(drv, { driverId: drv.id, kind: 'OTHER', description: 'Тест', amount: 1000 }), 403);
    await err(DB.addDebt(acc, { driverId: drv.id, kind: 'SETTLEMENT_DEBT', description: 'Тест', amount: 1000 }), 400);
    const d = await DB.addDebt(acc, { driverId: drv.id, kind: 'ACCOUNTING_MISMATCH', description: 'Нягтлантай нийлээгүй 5000', amount: 5000 });
    expect((await DB.debtBoard(acc)).items[0]).toMatchObject({ id: drv.id, pending: 5000 });
    expect((await DB.driverDebtLedger(drv, drv.id)).summary.pending).toBe(5000);
    await err(DB.driverDebtLedger(drv2, drv.id), 403);
    await err(DB.resolveDebt(acc, d.id, { note: '' }), 400, 'reason_required');
    await DB.resolveDebt(acc, d.id, { note: 'Бэлнээр төлсөн' });
    expect((await DB.resolveDebt(acc, d.id, { note: 'Бэлнээр төлсөн' })).duplicate).toBe(true);
    const dd = await DB.dailyDebts(acc, today);
    expect([dd.createdTotal, dd.resolvedTotal]).toEqual([5000, 5000]);
    // Хувийн «Өрийн дэвтэр» (#79) огт хөндөгдөхгүй
    expect(await db.driverDebt.count()).toBe(0);
  });
});

describe('урьдчилгаа, нэмэлт барааны тооцоо', () => {
  it('жолооч илгээнэ (давхар дарахад нэг), нягтлан зөвшөөрнө; зөвшөөрснийг устгахгүй; Авах дүнд орохгүй', async () => {
    const k = key();
    const p = await S.createDriverPayment(drv, { kind: 'ADVANCE', date: today, amount: 50000, note: 'Бензин', idemKey: k });
    expect((await S.createDriverPayment(drv, { kind: 'ADVANCE', date: today, amount: 50000, idemKey: k })).duplicate).toBe(true);
    await err(S.createDriverPayment(drv, { kind: 'BAD', date: today, amount: 1, idemKey: key() }), 400);
    await err(S.approveDriverPayment(drv, p.payment.id, { approved: true }), 403);
    await S.approveDriverPayment(acc, p.payment.id, { approved: true });
    await err(S.deleteDriverPayment(drv, p.payment.id), 409, 'approved');
    const e = await S.createDriverPayment(drv, { kind: 'EXTRA', date: today, amount: 20000, idemKey: key() });
    await err(S.deleteDriverPayment(drv2, e.payment.id), 404);
    await S.deleteDriverPayment(drv, e.payment.id);
    const b = await S.accountingDay(acc, today);
    expect(b.payments.map((x) => [x.kind, x.amount, x.approved])).toEqual([['ADVANCE', 50000, true]]);
  });
});

describe('банкны импорт (хуучнаар нь)', () => {
  it('задлагч: Хаан банкны SMS, утас, CSV (зарлага алгасна)', () => {
    const p = B.parseKhanMessage('Khan Bank: 2026/11/11 14:30 5102xxxx dansand 35,000.00 MNT orlogo orson. Guilgeenii utga: 99112233 Bat. Uldegdel: 1,000,000.00 MNT');
    expect([p?.amount, p?.phone, p?.income, p?.description]).toEqual([35000, '99112233', true, '99112233 Bat']);
    expect(B.parseKhanMessage('Khan Bank: 5102xxxx dansnaas 10,000.00 MNT zarlaga garsan. Guilgeenii utga: 88112233')?.income).toBe(false);
    expect(B.extractPhones('tulbur 88001122, 99887766 12345678 199887766')).toEqual(['88001122', '99887766']);
    const c = B.parseCsv('Огноо,Утга,Дүн\n2026-11-11 10:00,"99112233, захиалга",35000\n2026.11.11,зарлага,-5000\nбуруу\n11/11/2026,88001122,12,000');
    expect(c.rows.map((r) => [r.description, r.amount])).toEqual([['99112233, захиалга', 35000]]);
    // Жинхэнэ Хаан банкны мессеж (эзний илгээсэн хэлбэр), нэг имэйлд олон; Хаан банкны биш → алгасна
    const real = 'Khan Bank:Tany\n5***2327 dansand\nORLOGO:18,000.00MNT orj\nULDEGDEL:1,600,559.00MNT\nbolloo.Utga:88588868 dornod\n\nKhan Bank:Tany\n5***2327 dansand\nORLOGO:24,000.00MNT orj\nULDEGDEL:1,684,409.00MNT\nlloo.Utga:Bayan-olgii.65429490\n\nKhan Bank:Tany\n5***2327 dansand\nORLOGO:15,000.00MNT orj\nULDEGDEL:1,699,409.00MNT\nbolloo.Utga:\n\nKhan Bank:Tany\n5***2327 dansnaas\nZARLAGA:5,000.00MNT garj\nbolloo.Utga:x';
    expect(B.parseKhanMessages(real).map((x) => [x.income, x.amount, x.phone])).toEqual([[true, 18000, '88588868'], [true, 24000, '65429490'], [true, 15000, null], [false, 5000, null]]);
    expect(B.parseKhanMessage('Таны захиалга 25,000 MNT, хямдрал 99112233')).toBe(null);
    expect(B.parseKhanMessage('Khan Bank: шинэ үйлчилгээ 99112233')).toBe(null);
    expect(B.extractPhones('5***2327 1,600,559.00 55112233 66112233 77112233')).toEqual(['55112233', '66112233', '77112233']);
    expect([c.debits, c.skipped >= 1]).toEqual([1, true]);
  });

  it('утас + дүнгээр «Мөнгө орсон» (дугаар солигдохгүй, Meta); хэсэгчлэн → нэмэлт гүйлгээгээр; давхардал; эрх', async () => {
    const o = (await O.createOrder(op, ub({ prepaidWait: true }))).order;
    expect(o.status).toBe('PENDING_PAYMENT');
    await err(B.importCsv(op, { text: 'a,b,c\n2026-11-11,x,1' }), 403);
    const r1 = await B.importCsv(acc, { text: `Огноо,Утга,Дүн\n${today},${o.phone} төлбөр,20000` });
    expect([r1.imported, r1.partial, r1.matched]).toEqual([1, 1, 0]);
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('PENDING_PAYMENT');
    const r2 = await B.importCsv(acc, { text: `Огноо,Утга,Дүн\n${today},${o.phone} үлдэгдэл,10000\n${today},${o.phone} үлдэгдэл,10000` });
    expect([r2.imported, r2.matched, r2.duplicates]).toEqual([1, 1, 1]);
    const u = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect([u.number, u.status, u.prepaid]).toEqual([o.number, 'NEW', true]);
    expect(await db.metaEvent.count({ where: { orderId: o.id } })).toBe(1);
    const txs = await db.bankTransaction.findMany({ where: { orderId: o.id } });
    expect(txs.map((t) => t.status).sort()).toEqual(['MATCHED', 'MATCHED']);
    const st = await B.bankStats(op, {});
    expect([st.total.count, st.matched.count, st.duplicate.count]).toEqual([3, 2, 1]);
    expect((await B.listTransactions(op, { tab: 'DUPLICATE' })).items).toHaveLength(1);
    expect((await B.exportCsv(op, {})).split('\n')).toHaveLength(4);
  });

  it('гүйлгээ түрүүлж орсон бол шинэ «Төлбөр хүлээж буй» захиалга автоматаар таарна; гараар тааруулах; буцаасан; дүн өөрчлөгдсөн', async () => {
    const phone = '99887711';
    await B.importCsv(acc, { text: `Огноо,Утга,Дүн\n${today},${phone},${TOTAL}\n${today},өөр хүн,7000` });
    const o = (await O.createOrder(op, ub({ phone, prepaidWait: true }))).order;
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('NEW');
    const other = (await O.createOrder(op, ub({ prepaidWait: true, lines: [{ variantId: v1, qty: 1 }] }))).order;
    const free = await db.bankTransaction.findFirstOrThrow({ where: { amount: 7000 } });
    await err(B.manualMatch(op, free.id, { orderNumber: other.number }), 403);
    const m = await B.manualMatch(acc, free.id, { orderNumber: other.number });
    expect([m.paid, m.total, m.paidMarked]).toEqual([7000, 10000, false]);
    const pc = await B.priceChanges(acc, {});
    expect(pc.items.map((x) => [x.number, x.diff])).toEqual([[other.number, -3000]]);
    await B.setRefunded(acc, free.id, { refunded: true });
    expect((await B.priceChanges(acc, {})).items).toHaveLength(0);
    expect((await B.listTransactions(acc, { tab: 'REFUNDED' })).items).toHaveLength(1);
  });

  it('Gmail (Тохиргоо): хаяг + 16 оронтой App Password шифрлэгдэж хадгалагдана, API-д гарахгүй; Sync → импорт, давтахад давхардахгүй; буруу нууц үг', async () => {
    await err(GM.setGmailSettings(op, { email: 'a@gmail.com', appPassword: 'abcdefghijklmnop' }), 403);
    await err(GM.setGmailSettings(sa, { email: 'a@gmail.com', appPassword: '12345' }), 400, 'bad_app_password');
    await err(GM.gmailSync(sa), 400, 'gmail_not_configured');
    const v = await GM.setGmailSettings(sa, { email: 'Shop@Gmail.com', appPassword: 'abcd efgh ijkl mnop', autoSync: true });
    expect(v).toMatchObject({ email: 'shop@gmail.com', hasPassword: true });
    expect(JSON.stringify(v)).not.toContain('abcdefghijklmnop');
    const raw = JSON.stringify((await db.appSetting.findUniqueOrThrow({ where: { key: 'bank.gmail' } })).value);
    expect(raw).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(await GM.gmailStatus(sa))).not.toContain('passwordEnc');
    const o = (await O.createOrder(op, ub({ prepaidWait: true }))).order;
    let seen: { email: string; password: string } | null = null;
    GM._setMailFetcher(async (x) => { seen = x; return [
      { id: 'm1', date: new Date(), text: `Khan Bank: 5102xxxx dansand 30,000.00 MNT orlogo orson. Guilgeenii utga: ${o.phone} tulbur. Uldegdel: 1,000.00 MNT` },
      { id: 'm2', date: new Date(), text: 'Khan Bank: 5102xxxx dansnaas 5,000.00 MNT zarlaga garsan. Guilgeenii utga: 88112233' },
      { id: 'm3', date: new Date(), text: 'Сайн байна уу, энэ банкны мэдэгдэл биш' },
      { id: 'm4', date: new Date(), text: 'Khan Bank:Tany\n5***2327 dansand\nORLOGO:20,000.00MNT orj\nULDEGDEL:1,000.00MNT\nbolloo.Utga:' },
      { id: 'm5', date: new Date(), text: 'Khan Bank:Tany\n5***2327 dansand\nORLOGO:20,000.00MNT orj\nULDEGDEL:1,020.00MNT\nbolloo.Utga:' },
    ]; });
    try {
      const r = await GM.gmailSync(sa);
      expect(seen).toEqual({ email: 'shop@gmail.com', password: 'abcdefghijklmnop', sender: '', days: 3 });
      expect([r.emails, r.imported, r.matched, r.skipped]).toEqual([5, 3, 1, 2]); // утгагүй ижил дүнтэй 2 өөр гүйлгээ давхардал биш
      expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('NEW');
      const r2 = await GM.gmailSync(sa);
      expect([r2.imported, r2.alreadyImported]).toEqual([0, 3]);
      // Цэвэрлэгээ: холбогдоогүй Gmail гүйлгээ устаж дахин орно, таарсан нь хэвээр
      await db.bankTransaction.create({ data: { txDate: new Date(), description: 'хог имэйл', amount: 999, source: 'GMAIL', emailMessageId: 'junk1', importedByName: 'x' } });
      await err(GM.cleanupGmailImports(op), 403);
      const cl = await GM.cleanupGmailImports(sa);
      expect([cl.deleted, cl.linkedKept, cl.resync?.imported]).toEqual([3, 1, 2]);
      expect(await db.bankTransaction.count({ where: { emailMessageId: 'junk1' } })).toBe(0);
      expect((await GM.gmailStatus(sa)).settings.lastOk).toBe(true);
      GM._setMailFetcher(async () => { throw new (await import('@/lib/errors')).AppError(400, 'Gmail нэвтэрч чадсангүй', 'gmail_auth'); });
      await err(GM.gmailSync(sa), 400, 'gmail_auth');
      expect((await GM.gmailStatus(sa)).settings).toMatchObject({ lastOk: false });
      // Нууц үг хоосон үлдээвэл хуучнаараа
      await GM.setGmailSettings(sa, { email: 'shop@gmail.com', sender: 'khanbank' });
      expect((await GM.gmailStatus(sa)).settings.hasPassword).toBe(true);
      await GM.setGmailSettings(sa, { disconnect: true });
      expect((await GM.gmailStatus(sa)).configured).toBe(false);
    } finally { GM._setMailFetcher(null); }
  });
});
