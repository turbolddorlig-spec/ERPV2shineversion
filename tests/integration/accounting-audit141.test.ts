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

/** Аудит #141 — нягтлангийн хуудасны эрсдэлүүдийн засвар */
describe('#141 нягтлан: данс хязгаар, хүчээр хаах, хүргэснээ буцаах, ачаалал', () => {
  it('«Данс» дүн нь «Данс» гэж тэмдэглэсэн хүргэлтээс хэтрэхгүй (бэлнийг данс гэж нуухгүй)', async () => {
    const [a, b] = await outFor(drv, 2);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await DR.deliverOrder(drv, b!, { payment: 'BANK' });
    const day = await row(drv);
    expect([day.cash, day.bank]).toEqual([TOTAL, TOTAL]);
    await err(S.submitSettlement(drv, { date: today, cash: 0, bank: day.toReceive, debt: 0 }), 400, 'bank_over');
    await S.submitSettlement(drv, { date: today, cash: day.toReceive - TOTAL, bank: TOTAL, debt: 0 });
    const s = await db.driverSettlement.findFirstOrThrow({ where: { driverId: drv.id } });
    await S.approveSettlement(acc, s.id);
    expect((await db.driverSettlement.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('COMPLETED');
  });

  it('нягтлан хүчээр хаана: данс + бэлэн, дутуу нь өр; дараа нь жолооч юу ч өөрчлөхгүй; жолооч өөрөө хаахгүй', async () => {
    const [a, b, c] = await outFor(drv, 3);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await DR.deliverOrder(drv, b!, { payment: 'BANK' });
    const S2 = S as typeof S & { forceCloseSettlement: (a: UserActor, i: Record<string, unknown>) => Promise<{ debt: number }> };
    await err(S2.forceCloseSettlement(acc, { driverId: drv.id, date: today, cash: 0, bank: 0, note: 'тест' }), 409, 'unfinished');
    await DR.driverCancel(drv, c!, { note: 'Утсаа авсангүй' });
    const day = await row(drv);
    await err(S2.forceCloseSettlement(drv, { driverId: drv.id, date: today, cash: 0, bank: 0, note: 'тест' }), 403);
    await err(S2.forceCloseSettlement(acc, { driverId: drv.id, date: today, cash: 0, bank: 0, note: '' }), 400, 'reason_required');
    await err(S2.forceCloseSettlement(acc, { driverId: drv.id, date: today, cash: day.toReceive, bank: 1, note: 'илүү' }), 400, 'over');
    await err(S2.forceCloseSettlement(acc, { driverId: drv.id, date: today, cash: 0, bank: TOTAL + 1, note: 'данс их' }), 400);
    const r = await S2.forceCloseSettlement(acc, { driverId: drv.id, date: today, cash: 10000, bank: 12000, note: 'Жолооч 2 хоног илгээгээгүй' });
    expect(r.debt).toBe(day.toReceive - 22000);
    const s = await db.driverSettlement.findFirstOrThrow({ where: { driverId: drv.id } });
    expect([s.status, s.cashAmount, s.bankAmount, s.debtAmount]).toEqual(['COMPLETED', 10000, 12000, day.toReceive - 22000]);
    expect(await db.companyDebt.aggregate({ where: { driverId: drv.id, kind: 'SETTLEMENT_DEBT' }, _sum: { amount: true } })).toEqual({ _sum: { amount: day.toReceive - 22000 } });
    await err(DR.undoDelivery(drv, a!, { note: 'буцаая' }), 409, 'day_locked');
    await err(S.submitSettlement(drv, { date: today, cash: 0, bank: 0, debt: day.toReceive }), 409, 'day_locked');
    await err(S2.forceCloseSettlement(acc, { driverId: drv.id, date: today, cash: 0, bank: 0, note: 'дахин' }), 409, 'day_locked');
    expect(await db.auditLog.count({ where: { action: 'settlement.force_closed' } })).toBe(1);
    await recOk();
  });

  it('жолооч «Хүргэсэн»-ээ зөвхөн тэр өдөртөө буцаана; өмнөх өдрийнхийг нягтлан', async () => {
    const [a] = await outFor(drv, 1);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await db.order.update({ where: { id: a! }, data: { deliveredAt: new Date(Date.now() - 86_400_000 * 1.2) } });
    await err(DR.undoDelivery(drv, a!, { note: 'андуурсан' }), 409, 'too_old');
    await db.order.update({ where: { id: a! }, data: { deliveredAt: new Date() } });
    await DR.undoDelivery(drv, a!, { note: 'андуурсан' });
    expect((await db.order.findUniqueOrThrow({ where: { id: a! } })).status).toBe('CANCELLED');
  });

  it('50-аас олон захиалгыг хуваарилахад хэсэгчилж бүгд оноогдоно', async () => {
    await D.createReceipt(wh, { warehouseId: mainWh, lines: [{ variantId: v1, qty: 200 }, { variantId: v2, qty: 100 }], idemKey: key() });
    const ids: number[] = [];
    for (let i = 0; i < 70; i++) ids.push((await O.createOrder(op, ub({ deliveryDate: today }))).order.id);
    const r = await L.assignOrders(lead, { ids, driverId: drv.id });
    expect([r.assigned.length, r.skipped.length]).toEqual([70, 0]);
    expect(await db.order.count({ where: { id: { in: ids }, status: 'ASSIGNED', driverId: drv.id } })).toBe(70);
  });

  it('хүнд хүсэлтийн хязгаар: нийт 3-аас ихгүй зэрэг, тусгай түлхүүр 1; хэтэрвэл 429', async () => {
    const { withHeavy } = await import('@/lib/heavy');
    let now = 0; let peak = 0;
    const job = () => withHeavy(async () => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 60)); now--; return 1; });
    expect((await Promise.all(Array.from({ length: 8 }, job))).length).toBe(8);
    expect(peak).toBe(3);
    let one = 0; let onePeak = 0;
    const ex = () => withHeavy(async () => { one++; onePeak = Math.max(onePeak, one); await new Promise((r) => setTimeout(r, 30)); one--; }, { name: 't-export', max: 1 });
    await Promise.all([ex(), ex(), ex()]);
    expect(onePeak).toBe(1);
  });
});
