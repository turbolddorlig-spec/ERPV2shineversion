import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** Модуль 5 — жолооч: хүргэсэн (хэсэгчилсэн), цуцлах, маргааш, асуудал, буцаалт, нэмэлт бараа, pickup, хяналт — бүх замд тулгалт 0 (B2) */
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
});

let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(75000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
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

let sa: UserActor; let op: UserActor; let lead: UserActor; let wh: UserActor; let acc: UserActor; let drv: UserActor; let drv2: UserActor;
let page1: number; let v1: number; let v2: number; let mainWh: number; let wh2: number;
let today: string; let tomorrow: string;
let phoneSeq = 0;
const ub = (over: Record<string, unknown> = {}) => ({
  phone: String(99000000 + ++phoneSeq), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Тест 45-р байр',
  pageId: page1, lines: [{ variantId: v1, qty: 2 }], idemKey: key(), ...over,
});
const bal = async (locationId: number, variantId: number) => (await db.stockBalance.findUnique({ where: { locationId_variantId: { locationId, variantId } } }))?.qty ?? 0;
const locOf = async (warehouseId: number) => (await db.stockLocation.findUniqueOrThrow({ where: { warehouseId } })).id;
const drvLoc = async (u: UserActor) => (await db.stockLocation.findUnique({ where: { kind_userId: { kind: 'DRIVER', userId: u.id } } }))?.id ?? -1;
async function checkAll(id: number) {
  const d = await H.handoverDetail(wh, id);
  for (const i of d.items) await H.setCheck(wh, id, { variantId: i.variantId, checked: true });
}

beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); op = await actor(['OPERATOR']); lead = await actor(['DRIVER_LEAD']); wh = await actor(['WAREHOUSE']);
  acc = await actor(['ACCOUNTING']); drv = await actor(['DRIVER']); drv2 = await actor(['DRIVER']);
  page1 = (await A.savePage(sa, { name: 'Гутал Шоп' })).id;
  const p = await P.createProduct(sa, { code: 'G1', name: 'Гутлын үдээс', price: 10000, sizes: ['S', 'L'] });
  [v1, v2] = p.variants.map((v) => v.id) as [number, number];
  mainWh = (await W.createWarehouse(sa, { name: 'Төв агуулах' })).id; // эхнийх = үндсэн
  wh2 = (await W.createWarehouse(sa, { name: 'Агуулах 2' })).id;
  await D.createReceipt(wh, { warehouseId: mainWh, lines: [{ variantId: v1, qty: 20 }, { variantId: v2, qty: 5 }], idemKey: key() });
  await D.createReceipt(wh, { warehouseId: wh2, lines: [{ variantId: v2, qty: 10 }], idemKey: key() });
  today = U.ubDay(); tomorrow = U.ubDay(new Date(), 1);
  await H.setTrusted(acc, { driverId: drv.id, trusted: true });
});

const recOk = async () => {
  const r = await V.reconcile(sa, { fresh: true });
  expect(r.ok).toBe(true);
  expect(await db.stockBalance.count({ where: { qty: { lt: 0 } } })).toBe(0);
};
/** Захиалгууд → жолоочид → падаан өгсөн (бараа жолоочид) */
async function outFor(driver: UserActor, n = 1, lines = [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 1 }]) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push((await O.createOrder(op, ub({ deliveryDate: today, lines }))).order.id);
  await L.assignOrders(lead, { ids, driverId: driver.id });
  const h = await H.createHandover(wh, { driverId: driver.id, date: today, orderIds: ids });
  await H.prepareHandover(wh, h.id); await checkAll(h.id); await H.confirmHandover(wh, h.id);
  await H.setDriverCheck(driver, h.id, { variantId: 'all', checked: true }); await H.receiveHandover(driver, h.id);
  return ids;
}
/** Тухайн өдрийн падаан → агуулах өгөх → жолооч хүлээн авах */
async function handTo(driver: UserActor, date: string, ids: number[]) {
  const h = await H.createHandover(wh, { driverId: driver.id, date, orderIds: ids });
  await H.prepareHandover(wh, h.id); await checkAll(h.id); await H.confirmHandover(wh, h.id);
  await H.setDriverCheck(driver, h.id, { variantId: 'all', checked: true }); await H.receiveHandover(driver, h.id);
}
const goods = async (u: UserActor) => {
  const g = await G.goodsView(u.id);
  return Object.fromEntries(g.items.map((i) => [i.variantId, [i.balance, i.held, i.returnable]]));
};
const lineOf = async (orderId: number, variantId: number) => (await db.orderLine.findFirstOrThrow({ where: { orderId, variantId } })).id;


/** Аудит #144 — жолоочийн хуудасны эрсдэлүүдийн засвар */
describe('#144 жолооч: нэмэлт барааны хязгаар, түлхүүр, падаан нуух, маргааш таб, хоёр утас, огноо', () => {
  it('нэмэлт бараа: нэг бараанаас 10, өдөрт нийт 30 (тохиргоо) хүртэл', async () => {
    await D.createReceipt(wh, { warehouseId: mainWh, lines: [{ variantId: v1, qty: 100 }], idemKey: key() });
    await err(G.extraTake(drv, { lines: [{ variantId: v1, qty: 11 }], idemKey: key() }), 400, 'extra_limit');
    await G.extraTake(drv, { lines: [{ variantId: v1, qty: 10 }], idemKey: key() });
    await G.extraTake(drv, { lines: [{ variantId: v1, qty: 10 }], idemKey: key() });
    await G.extraTake(drv, { lines: [{ variantId: v1, qty: 10 }], idemKey: key() });
    await err(G.extraTake(drv, { lines: [{ variantId: v1, qty: 1 }], idemKey: key() }), 409, 'extra_limit');
    await G.extraTake(drv2, { lines: [{ variantId: v1, qty: 5 }], idemKey: key() }); // өөр жолооч тусдаа
    await A.setOrderSettings(sa, { extraDailyMax: 40 });
    await G.extraTake(drv, { lines: [{ variantId: v1, qty: 10 }], idemKey: key() });
  });

  it('«debt-» түлхүүр жолоочид хориотой; өөр жолоочийн баримтын түлхүүрээр түүний мэдээлэл харагдахгүй', async () => {
    await D.createReceipt(wh, { warehouseId: mainWh, lines: [{ variantId: v1, qty: 20 }], idemKey: key() });
    await err(G.extraTake(drv, { lines: [{ variantId: v1, qty: 1 }], idemKey: 'debt-1001' }), 400, 'bad_idem');
    const k = key();
    await G.extraTake(drv, { lines: [{ variantId: v1, qty: 2 }], idemKey: k });
    await err(G.extraTake(drv2, { lines: [{ variantId: v1, qty: 1 }], idemKey: k }), 409, 'idem_conflict');
    expect((await G.extraTake(drv, { lines: [{ variantId: v1, qty: 2 }], idemKey: k })).duplicate).toBe(true);
  });

  it('агуулах «өгсөн» болохоос өмнө жолоочид падааны утас, дүн, бараа харагдахгүй', async () => {
    const ids = [(await O.createOrder(op, ub({ deliveryDate: today }))).order.id];
    await L.assignOrders(lead, { ids, driverId: drv.id });
    const h = await H.createHandover(wh, { driverId: drv.id, date: today, orderIds: ids });
    const pre = (await H.myHandover(drv)).handover!;
    expect(pre.totals.amount).toBe(0);
    expect(pre.orders.every((o) => o.phone === '' && o.total === 0 && o.lines.length === 0)).toBe(true);
    expect(pre.items).toEqual([]);
    expect((await H.myHandoverPending(drv)).pending).toBe(0);
    await H.prepareHandover(wh, h.id); await checkAll(h.id); await H.confirmHandover(wh, h.id);
    const given = (await H.myHandover(drv)).handover!;
    expect(given.totals.amount).toBeGreaterThan(0);
    expect(given.items.length).toBeGreaterThan(0);
    expect((await H.myHandoverPending(drv)).pending).toBe(1);
  });

  it('«Маргааш» таб: өөр жолоочид шилжсэн захиалга харагдахгүй', async () => {
    const [a] = await outFor(drv, 1);
    await DR.postponeOrder(drv, a!, {});
    expect((await DR.driverOrders(drv, 'tomorrow')).items.map((x) => x.id)).toContain(a);
    await L.assignOrders(lead, { ids: [a!], driverId: drv2.id });
    const t = await DR.driverOrders(drv, 'tomorrow');
    expect(t.items.map((x) => x.id)).not.toContain(a);
    expect(t.counts.postponed).toBe(0);
  });

  it('хоёр утаснаас: эхнийх «Бэлэн», дараагийнх «Төлөөгүй» → чимээгүй амжилт биш, анхааруулна', async () => {
    const [a] = await outFor(drv, 1);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    expect((await DR.deliverOrder(drv, a!, { payment: 'CASH' })).duplicate).toBe(true);
    await err(DR.deliverOrder(drv, a!, { payment: 'UNPAID' }), 409, 'already_delivered');
    expect((await db.order.findUniqueOrThrow({ where: { id: a! } })).deliveryPayment).toBe('CASH');
  });

  it('огноо солих: 50-аас олон захиалгыг хэсэгчилж бүгд солигдоно', async () => {
    await D.createReceipt(wh, { warehouseId: mainWh, lines: [{ variantId: v1, qty: 200 }, { variantId: v2, qty: 100 }], idemKey: key() });
    const ids: number[] = [];
    for (let i = 0; i < 60; i++) ids.push((await O.createOrder(op, ub({ phone: String(88100000 + i), deliveryDate: today }))).order.id);
    const r = await L.setDeliveryDate(lead, { ids, date: tomorrow });
    expect([r.updated, r.skipped.length]).toEqual([60, 0]);
    expect(await db.order.count({ where: { id: { in: ids }, deliveryDate: U.dateOnly(tomorrow) } })).toBe(60);
  });
});
