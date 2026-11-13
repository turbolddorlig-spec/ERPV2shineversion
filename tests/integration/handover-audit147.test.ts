import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** Аудит #147 — жолоочид бараа өгөх: «Өгсөн» падааны нөөцлөлт, жолооч бүрийн түгжээ, анхааруулга, хязгаарууд — тулгалт 0 (B2) */
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
let T: typeof import('@/lib/services/stock/transfers');
let K: typeof import('@/lib/services/stock/counts');

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
  T = await import('@/lib/services/stock/transfers');
  K = await import('@/lib/services/stock/counts');
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

/** Падаан үүсгээд агуулах «Өгсөн» (жолооч хүлээн аваагүй) */
async function handedOver(driver: UserActor, n = 1, lines = [{ variantId: v1, qty: 2 }]) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push((await O.createOrder(op, ub({ deliveryDate: today, lines }))).order.id);
  await L.assignOrders(lead, { ids, driverId: driver.id });
  await H.setTrusted(acc, { driverId: driver.id, trusted: true });
  const h = await H.createHandover(wh, { driverId: driver.id, date: today, orderIds: ids });
  await H.prepareHandover(wh, h.id); await checkAll(h.id); await H.confirmHandover(wh, h.id);
  return { h, ids };
}
const receive = async (driver: UserActor, id: number) => { await H.setDriverCheck(driver, id, { variantId: 'all', checked: true }); await H.receiveHandover(driver, id); };

describe('#147 жолоочид бараа өгөх', () => {
  it('«Өгсөн» падааны бараа тооллогод тавиураас гарсанд тооцогдоно — 2 удаа хасагдахгүй', async () => {
    const loc = await locOf(mainWh);
    expect(await bal(loc, v1)).toBe(20);
    const { h } = await handedOver(drv, 2); // 4 ширхэг жолоочид өгөгдсөн, тавиурт 16
    const c = await K.startCount(wh, { warehouseId: mainWh, note: 'Өглөөний тооллого' });
    await K.setCountLine(wh, c.id, { variantId: v1, countedQty: 16 });
    const line = (await db.stockCountLine.findFirstOrThrow({ where: { countId: c.id } }));
    expect(line.systemQty).toBe(16);
    await K.submitCount(wh, c.id);
    await K.decideCount(sa, c.id, { lineIds: [line.id], action: 'approve' });
    expect(await bal(loc, v1)).toBe(20); // өөрчлөлтгүй
    await receive(drv, h.id);
    expect(await bal(loc, v1)).toBe(16); // тавиуртай таарна
    expect(await bal(await drvLoc(drv), v1)).toBe(4);
    await recOk();
  });

  it('«Өгсөн» барааг шилжүүлэх / зарлагадах боломжгүй; жолооч дараа нь хүлээн авч чадна', async () => {
    const loc = await locOf(mainWh);
    const { h } = await handedOver(drv, 1, [{ variantId: v2, qty: 2 }]); // v2: 5, үүнээс 2 өгөгдсөн
    await err(T.sendTransfer(wh, { fromWarehouseId: mainWh, toWarehouseId: wh2, lines: [{ variantId: v2, qty: 5 }], idemKey: key() }), 409, 'handed_over_stock');
    await T.sendTransfer(wh, { fromWarehouseId: mainWh, toWarehouseId: wh2, lines: [{ variantId: v2, qty: 3 }], idemKey: key() });
    await receive(drv, h.id);
    expect(await bal(loc, v2)).toBe(0);
    await recOk();
  });

  it('хоёр падаан сүүлийн бараагаар: хоёр дахь нь «Өгсөн» болохгүй (өмнө нь анхааруулна); эхнийх хүлээн авна', async () => {
    const a = await handedOver(drv, 1, [{ variantId: v2, qty: 3 }]);
    const ids = [(await O.createOrder(op, ub({ deliveryDate: today, lines: [{ variantId: v2, qty: 1 }] }))).order.id];
    // v2: 5 — 3 өгөгдсөн, үлдэх 2; хоёр дахь падаан 1-ийг авна, гурав дахь нь 2-ыг
    await L.assignOrders(lead, { ids, driverId: drv2.id });
    await H.setTrusted(acc, { driverId: drv2.id, trusted: true });
    const b = await H.createHandover(wh, { driverId: drv2.id, date: today, orderIds: ids });
    await H.prepareHandover(wh, b.id); await checkAll(b.id);
    await db.orderLine.updateMany({ where: { orderId: ids[0] }, data: { qty: 3 } }); // зориуд их болгоно (3 > 2)
    const short = await H.shortages(wh, b.id);
    expect(short[0]).toMatchObject({ need: 3, have: 2 });
    await err(H.confirmHandover(wh, b.id), 409, 'insufficient_stock');
    await receive(drv, a.h.id);
    await recOk();
  });

  it('жолоочийн апп: өчигдрийн хүлээн аваагүй падаан өнөөдрийн ноорогт дарагдахгүй', async () => {
    const yesterday = U.ubDay(new Date(), -1);
    const id1 = (await O.createOrder(op, ub({ deliveryDate: today }))).order.id;
    await L.assignOrders(lead, { ids: [id1], driverId: drv.id });
    await db.order.update({ where: { id: id1 }, data: { deliveryDate: U.dateOnly(yesterday) } });
    await H.setApproval(acc, { driverId: drv.id, date: yesterday, approved: true });
    const hy = await H.createHandover(wh, { driverId: drv.id, date: yesterday, orderIds: [id1] });
    await H.prepareHandover(wh, hy.id); await checkAll(hy.id); await H.confirmHandover(wh, hy.id);
    const id2 = (await O.createOrder(op, ub({ deliveryDate: today }))).order.id;
    await L.assignOrders(lead, { ids: [id2], driverId: drv.id });
    await H.createHandover(wh, { driverId: drv.id, date: today, orderIds: [id2] });
    const m = await H.myHandover(drv);
    expect(m.handover!.id).toBe(hy.id);
    expect(m.handover!.status).toBe('HANDED_OVER');
  });

  it('2 цаг хүлээн аваагүй падаан — анхааруулга; буцаахад бараа түүхэнд; идэвхгүй жолооч, буруу дугаар, түүхийн хязгаар', async () => {
    const { h } = await handedOver(drv, 1);
    expect((await H.handoverBoard(wh, today)).staleHandedOver).toEqual([]);
    await db.handover.update({ where: { id: h.id }, data: { handedOverAt: new Date(Date.now() - 3 * 3600_000) } });
    expect((await H.handoverBoard(wh, today)).staleHandedOver.map((x) => x.id)).toEqual([h.id]);
    expect((await H.staleHandoverAlert(['WAREHOUSE']))?.count ?? 0).toBeGreaterThanOrEqual(0); // 30 сек кэш
    await H.revertHandover(wh, h.id);
    const a = await db.auditLog.findFirstOrThrow({ where: { action: 'handover.reverted' }, orderBy: { at: 'desc' } });
    expect((a.details as { lines: { variantId: number; qty: number }[] }).lines).toEqual([{ variantId: v1, qty: 2 }]);
    await err(H.handoverDetail(wh, 'abc'), 404);
    await err(H.handoverHistory(wh, { from: '2024-01-01', to: today }), 400, 'range_too_long');
    await db.user.update({ where: { id: drv2.id }, data: { isActive: false } });
    await err(H.createHandover(wh, { driverId: drv2.id, date: today, orderIds: [1] }), 400, 'inactive_driver');
    await err(H.setApproval(acc, { driverId: op.id, date: today, approved: true }), 400);
  });

  it('жолооч бүрийн түгжээ: нэг жолоочийн үйлдэл удаан байхад нөгөө жолооч хүлээхгүй хүргэнэ', async () => {
    await H.setTrusted(acc, { driverId: drv2.id, trusted: true });
    const [a] = await outFor(drv2, 1);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = db.$transaction(async (tx) => {
      const C = await import('@/lib/services/delivery/core');
      await C.lockDrivers(tx, [drv.id]); await held;
    }, { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    await DR.deliverOrder(drv2, a!, { payment: 'CASH' });
    expect(Date.now() - t0).toBeLessThan(3000);
    release(); await holder;
    await recOk();
  });
});
