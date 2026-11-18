import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';
import { bankPay } from '../helpers/bankPay';

/** #169 — жолоочийн «Хүргэлт» таб хуучин систем шиг: зөвхөн өнөөдрийн падаан; маргааш нь «Өчигдөр», нөгөөдөр алга */
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

const ids = (r: { items: { id: number }[] }) => r.items.map((x) => x.id).sort((a, b) => a - b);
const day = (n: number) => new Date(U.ubDay(new Date(), n) + 'T00:00:00Z');
describe('#169/#170 жолоочийн табууд ПАДААНААР', () => {
  it('хуучин огноотой захиалга өнөөдрийн падаанд → Хүргэлт; хүргэхэд падааныхаа бусадтай хамт Хүргэсэн-д; нягтланд падааны бүх захиалга', async () => {
    const [a, b] = await outFor(drv, 2, [{ variantId: v1, qty: 1 }]) as [number, number];
    // b захиалга 4 хоногийн өмнө үүссэн, огноо нь хуучин — гэхдээ өнөөдрийн падаанд
    await db.order.update({ where: { id: b }, data: { deliveryDate: day(-4), createdAt: new Date(Date.now() - 4 * 86_400_000) } });
    expect(ids(await DR.driverOrders(drv, 'delivery'))).toEqual([a, b]);
    expect((await DR.driverOrders(drv, 'delivery')).counts.delivery).toBe(2);
    await DR.deliverOrder(drv, b, { payment: 'CASH' });
    expect(ids(await DR.driverOrders(drv, 'delivered'))).toEqual([b]);
    expect(ids(await DR.driverOrders(drv, 'all'))).toEqual([a, b]);
    const acc = (await import('@/lib/services/accounting/calc'));
    const rows = await acc.computeDay(db as never, today, drv.id);
    expect(rows[0]?.delivered).toBe(1);
  });

  it('өчигдрийн падаан → зөвхөн «Өчигдөр» (тэндээс хүргэнэ, хүргэсэн ч тэндээ); 2 хоногийн падаан — апп-д алга', async () => {
    const [y1, y2] = await outFor(drv, 2, [{ variantId: v1, qty: 1 }]) as [number, number];
    const h = await db.handover.findFirstOrThrow({ where: { driverId: drv.id } });
    await db.handover.update({ where: { id: h.id }, data: { date: day(-1) } });
    await db.order.updateMany({ where: { id: { in: [y1, y2] } }, data: { deliveryDate: day(-1) } });
    expect(ids(await DR.driverOrders(drv, 'delivery'))).toEqual([]);
    const y = await DR.driverOrders(drv, 'yesterday');
    expect(ids(y)).toEqual([y1, y2]);
    expect((y.items[0] as { can: { deliver: boolean } }).can.deliver).toBe(true);
    await DR.deliverOrder(drv, y1, { payment: 'CASH' });
    expect(ids(await DR.driverOrders(drv, 'yesterday'))).toEqual([y1, y2]);
    expect(ids(await DR.driverOrders(drv, 'delivered'))).toEqual([]);
    // Нөгөөдөр
    await db.handover.update({ where: { id: h.id }, data: { date: day(-2) } });
    for (const t of ['all', 'delivery', 'delivered', 'cancelled', 'tomorrow', 'yesterday']) expect(ids(await DR.driverOrders(drv, t))).not.toContain(y2);
  });
});
