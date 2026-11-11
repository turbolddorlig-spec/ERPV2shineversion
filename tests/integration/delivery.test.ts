import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** Модуль 4 — падаан: хуваарилах, падаан, Check, бараа жолоочид шилжих, буцаах, OKEY, зэрэг үйлдэл, үлдэгдэл (B2) */
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

describe('хуваарилах (ахлах жолооч)', () => {
  it('Шинэ → Жолоочид оноосон; он сар өдөртэй, төлбөр хүлээж буй алгасна; эрх', async () => {
    const a = (await O.createOrder(op, ub())).order;
    const sch = (await O.createOrder(op, ub({ deliveryDate: U.ubDay(new Date(), 5) }))).order;
    const rural = (await O.createOrder(op, ub({ province: 'Дархан-Уул', district: null, khoroo: null, addressDetail: '3-р баг' }))).order;
    await err(L.assignOrders(op, { ids: [a.id], driverId: drv.id }), 403);
    await err(L.assignOrders(wh, { ids: [a.id], driverId: drv.id }), 403);
    await err(L.assignOrders(lead, { ids: [a.id], driverId: op.id }), 400);
    const r = await L.assignOrders(lead, { ids: [a.id, sch.id, rural.id], driverId: drv.id });
    expect(r.assigned.map((x) => x.id)).toEqual([a.id]);
    expect(r.skipped.map((x) => x.reason).sort()).toEqual(['Он сар өдөртэй захиалга хуваарилах боломжгүй', 'Төлбөр хүлээж буй'].sort());
    const fresh = await db.order.findUniqueOrThrow({ where: { id: a.id } });
    expect([fresh.status, fresh.driverName, U.ymdOf(fresh.deliveryDate)]).toEqual(['ASSIGNED', drv.name, tomorrow]);
    const ls = await L.leadOrders(lead, { assign: 'assigned' });
    expect(ls.items.map((x) => x.id)).toEqual([a.id]);
    expect((await L.leadOrders(lead, {})).items.map((x) => x.id)).not.toContain(a.id); // анхдагч «Хуваарилаагүй»
    expect((await L.driversList(lead, tomorrow)).items.find((d) => d.id === drv.id)?.load).toBe(1);
  });

  it('зэрэг 2 ахлах жолооч нэг захиалгыг өөр жолоочид → дараалж, сүүлийнх үлдэнэ, алдаагүй', async () => {
    const a = (await O.createOrder(op, ub())).order;
    const lead2 = await actor(['DRIVER_LEAD']);
    await Promise.all([L.assignOrders(lead, { ids: [a.id], driverId: drv.id }), L.assignOrders(lead2, { ids: [a.id], driverId: drv2.id })]);
    const o = await db.order.findUniqueOrThrow({ where: { id: a.id } });
    expect(o.status).toBe('ASSIGNED');
    expect([drv.id, drv2.id]).toContain(o.driverId);
  });
});

describe('падаан', () => {
  async function dayWithOrders(n = 2) {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push((await O.createOrder(op, ub({ deliveryDate: today, lines: [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 1 }] }))).order.id);
    await L.assignOrders(lead, { ids, driverId: drv.id });
    return ids;
  }

  it('үүсгэх: OKEY заавал; бүх захиалгыг сонгох; давхар үүсэхгүй (зэрэг); эрх', async () => {
    const ids = await dayWithOrders(2);
    await err(H.createHandover(lead, { driverId: drv.id, date: today, orderIds: ids }), 403);
    await err(H.createHandover(wh, { driverId: drv.id, date: today, orderIds: [ids[0]] }), 400, 'not_all_selected');
    // Итгэлтэй ч гэсэн нягтлан ХОРИГ тавьвал үүсэхгүй
    await err(H.setApproval(acc, { driverId: drv.id, date: today, approved: false }), 400, 'reason_required');
    await H.setApproval(acc, { driverId: drv.id, date: today, approved: false, note: 'Өр 120,000₮' });
    await err(H.createHandover(wh, { driverId: drv.id, date: today, orderIds: ids }), 409, 'not_approved');
    await err(H.setApproval(wh, { driverId: drv.id, date: today, approved: true }), 403);
    await H.setApproval(acc, { driverId: drv.id, date: today, approved: true });
    const rs = await Promise.allSettled([1, 2, 3].map(() => H.createHandover(wh, { driverId: drv.id, date: today, orderIds: ids })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.handover.count()).toBe(1);
    const h = (rs.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof H.createHandover>>>).value;
    expect(h.number).toBe('П-000001');
    expect(h.items.map((i) => [i.variantId, i.qty])).toEqual(expect.arrayContaining([[v1, 4], [v2, 2]]));
    // Падаанд орсон захиалгыг засахгүй
    const o = await db.order.findUniqueOrThrow({ where: { id: ids[0] } });
    await err(O.updateOrder(op, o.id, { version: o.version, note: 'x' }), 409, 'in_handover');
    const board = await H.handoverBoard(wh, today);
    expect(board.drivers.find((d) => d.id === drv.id)).toMatchObject({ approved: true, orders: 2, stateLabel: 'Бэлдэж байна' });
  });

  it('«Барааг бүрэн өгсөн»: Check заавал; бараа агуулахаас жолоочид; нөөц суллагдана; зэрэг 2 дарахад нэг удаа; тулгалт 0', async () => {
    const ids = await dayWithOrders(2);
    const h = await H.createHandover(wh, { driverId: drv.id, date: today, orderIds: ids });
    await err(H.confirmHandover(wh, h.id), 409, 'not_prepared');
    await H.prepareHandover(wh, h.id);
    await err(H.confirmHandover(wh, h.id), 409, 'not_checked');
    await checkAll(h.id);
    const main = await locOf(mainWh);
    const [b1, b2] = [await bal(main, v1), await bal(main, v2)];
    const avBefore = (await P.searchVariants(op, 'G1')).find((x) => x.variantId === v1)!.available;
    const rs = await Promise.all([H.confirmHandover(wh, h.id), H.confirmHandover(wh, h.id)]);
    expect(rs.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect([await bal(main, v1), await bal(main, v2)]).toEqual([b1 - 4, b2 - 2]);
    const dl = await drvLoc(drv);
    expect([await bal(dl, v1), await bal(dl, v2)]).toEqual([4, 2]);
    expect(await db.stockReservation.count({ where: { orderId: { in: ids } } })).toBe(0);
    // Боломжтой тоо өөрчлөгдөхгүй (нөөцөөс → жолоочид)
    expect((await P.searchVariants(op, 'G1')).find((x) => x.variantId === v1)!.available).toBe(avBefore);
    expect((await db.order.findMany({ where: { id: { in: ids } } })).every((o) => o.status === 'OUT_FOR_DELIVERY' && o.outForDeliveryAt)).toBe(true);
    expect(await db.stockMove.count({ where: { type: 'HANDOVER' } })).toBe(2);
    const rec = await V.reconcile(sa, { fresh: true });
    expect(rec.ok).toBe(true);
    // Хүргэлтэд гарсан захиалгыг оператор цуцлахгүй (Модуль 5)
    await err(O.cancelOrder(op, ids[0], { reason: 'CUSTOMER_CANCELLED', note: 'Тест цуцлалт', version: 99 }), 409, 'order_locked');
  });

  it('үндсэн агуулахад хүрэлцэхгүй бол юу ч өөрчлөгдөхгүй (сөрөг үлдэгдэлгүй)', async () => {
    // v2: үндсэнд 5, агуулах 2-т 10 → 3 захиалга × 2 = 6 > 5
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push((await O.createOrder(op, ub({ deliveryDate: today, lines: [{ variantId: v2, qty: 2 }] }))).order.id);
    await L.assignOrders(lead, { ids, driverId: drv.id });
    const h = await H.createHandover(wh, { driverId: drv.id, date: today, orderIds: ids });
    expect((await H.shortages(wh, h.id)).map((s) => [s.need, s.have])).toEqual([[6, 5]]);
    await H.prepareHandover(wh, h.id); await checkAll(h.id);
    await err(H.confirmHandover(wh, h.id), 409, 'insufficient_stock');
    expect(await bal(await locOf(mainWh), v2)).toBe(5);
    expect((await db.handover.findUniqueOrThrow({ where: { id: h.id } })).status).toBe('PREPARED');
    expect(await db.stockBalance.count({ where: { qty: { lt: 0 } } })).toBe(0);
  });

  it('падаан өгсний дараа хуваарилсан захиалга → маргааш (#65); өгөхөөс өмнө бол падаанд нэмэгдэж Check арилна', async () => {
    const ids = await dayWithOrders(1);
    const h = await H.createHandover(wh, { driverId: drv.id, date: today, orderIds: ids });
    await H.prepareHandover(wh, h.id); await checkAll(h.id);
    const late = (await O.createOrder(op, ub({ deliveryDate: today, lines: [{ variantId: v1, qty: 1 }] }))).order;
    await L.assignOrders(lead, { ids: [late.id], driverId: drv.id });
    const d1 = await H.handoverDetail(wh, h.id);
    expect(d1.orders.find((o) => o.orderId === late.id)?.isNew).toBe(true);
    expect(d1.items.find((i) => i.variantId === v1)?.checked).toBe(false); // тоо өөрчлөгдсөн → дахин Check
    await checkAll(h.id);
    await H.confirmHandover(wh, h.id);
    const later = (await O.createOrder(op, ub({ deliveryDate: today, lines: [{ variantId: v1, qty: 1 }] }))).order;
    const r = await L.assignOrders(lead, { ids: [later.id], driverId: drv.id });
    expect(r.assigned[0]).toMatchObject({ date: tomorrow, movedNextDay: true });
    expect((await db.order.findUniqueOrThrow({ where: { id: later.id } })).handoverId).toBeNull();
    await err(L.setDeliveryDate(lead, { ids: [later.id], date: U.ubDay(new Date(), -1) }), 400, 'bad_date');
    const s = await L.setDeliveryDate(lead, { ids: [later.id], date: today });
    expect(s.skipped).toHaveLength(1); // тэр өдрийн падаан өгөгдсөн
  });

  it('өгөхөөс өмнө цуцалбал падаанаас хасагдаж (улаанаар), нөөц суллагдана; өөр жолоочид шилжүүлбэл ч мөн', async () => {
    const ids = await dayWithOrders(3);
    const h = await H.createHandover(wh, { driverId: drv.id, date: today, orderIds: ids });
    await checkAll(h.id);
    const o = await db.order.findUniqueOrThrow({ where: { id: ids[0] } });
    await O.cancelOrder(op, o.id, { reason: 'CUSTOMER_CANCELLED', note: 'Үйлчлүүлэгч болилоо', version: o.version });
    await L.assignOrders(lead, { ids: [ids[1]], driverId: drv2.id });
    const d = await H.handoverDetail(wh, h.id);
    expect(d.totals.orders).toBe(1);
    expect(d.orders.filter((x) => x.removedAt).map((x) => x.removeReason)).toEqual(['Цуцлагдсан', `Өөр жолоочид (${drv2.name}) шилжсэн`]);
    expect(d.items.every((i) => !i.checked)).toBe(true);
    expect(await db.stockReservation.count({ where: { orderId: ids[0] } })).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: ids[1] } })).handoverId).toBeNull();
  });

  it('«Буцаах» өгсний дараа: бараа жолоочоос агуулахад, нөөц сэргэнэ; «Падаан буцаах» зөвхөн ноорогт', async () => {
    const ids = await dayWithOrders(2);
    const h = await H.createHandover(wh, { driverId: drv.id, date: today, orderIds: ids });
    await H.prepareHandover(wh, h.id);
    await err(H.deleteHandover(wh, h.id), 409, 'not_draft');
    await checkAll(h.id);
    await H.confirmHandover(wh, h.id);
    const main = await locOf(mainWh);
    const before = await bal(main, v1);
    const r = await H.revertHandover(wh, h.id);
    expect(r.status).toBe('DRAFT');
    expect(await bal(main, v1)).toBe(before + 4);
    expect(await bal(await drvLoc(drv), v1)).toBe(0);
    expect(await db.stockReservation.count({ where: { orderId: { in: ids } } })).toBe(4);
    expect((await db.order.findMany({ where: { id: { in: ids } } })).every((o) => o.status === 'ASSIGNED')).toBe(true);
    await H.deleteHandover(wh, h.id);
    expect(await db.handover.count()).toBe(0);
    expect((await db.order.findMany({ where: { id: { in: ids } } })).every((o) => o.handoverId === null && o.status === 'ASSIGNED')).toBe(true);
    expect((await V.reconcile(sa, { fresh: true })).ok).toBe(true);
    const hist = await H.handoverHistory(wh, {});
    expect(hist.items).toHaveLength(0);
  });
});

describe('жолоочид явж буй бараа ил харагдана; цаг тутмын автомат тулгалт (B2)', () => {
  async function handOver(n: number, lines: { variantId: number; qty: number }[]) {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push((await O.createOrder(op, ub({ deliveryDate: today, lines }))).order.id);
    await L.assignOrders(lead, { ids, driverId: drv.id });
    const h = await H.createHandover(wh, { driverId: drv.id, date: today, orderIds: ids });
    await H.prepareHandover(wh, h.id); await checkAll(h.id); await H.confirmHandover(wh, h.id);
    return { ids, h };
  }

  it('нэг бараатай 2 захиалга жолоочид → агуулах ба барааны хуудсанд «Жолоочид 4»; нийт/боломжтойд орохгүй', async () => {
    await handOver(2, [{ variantId: v1, qty: 2 }]);
    const st = await V.stockList(sa, { ids: [v1] });
    const row = st.items[0]!;
    expect([row.driver, row.total, row.reserved, row.available]).toEqual([4, 16, 0, 16]);
    expect(row.drivers).toEqual([{ name: drv.name, qty: 4 }]);
    const pl = await P.listProducts(sa, { q: 'G1' } as never);
    const prod = pl.items.find((x) => x.code === 'G1')!;
    expect(prod.stock.driver).toBe(4);
    expect(prod.variants.find((v) => v.id === v1)!.stock.driver).toBe(4);
  });

  it('бүх ширхэг жолоочид гарсан бараа «Үлдэгдэлтэй» шүүлтүүрээс алга болохгүй', async () => {
    const p = await P.createProduct(sa, { code: 'G2', name: 'Ганц бараа', price: 5000 });
    const v = p.variants[0]!.id;
    await D.createReceipt(wh, { warehouseId: mainWh, lines: [{ variantId: v, qty: 2 }], idemKey: key() });
    await handOver(1, [{ variantId: v, qty: 2 }]);
    const st = await V.stockList(sa, { q: 'G2', inStock: true });
    expect(st.items.map((x) => [x.variantId, x.total, x.driver])).toEqual([[v, 0, 2]]);
  });

  it('автомат тулгалт: цагт нэг; зөрүү → түүх + Супер админд анхааруулга; засагдвал арилна', async () => {
    await handOver(2, [{ variantId: v1, qty: 2 }]);
    const s1 = await V.autoReconcile();
    expect(s1?.ok).toBe(true);
    expect(await V.autoReconcile()).toBeNull(); // 1 цаг болоогүй
    expect(await V.reconcileAlert(['SUPER_ADMIN'])).toBeNull();
    // Зориуд зөрүү үүсгэнэ (журналаас гадуур өөрчлөлт — бодит системд боломжгүй)
    const dl = await drvLoc(drv);
    await db.$executeRaw`UPDATE "StockBalance" SET qty = qty + 1 WHERE "locationId" = ${dl} AND "variantId" = ${v1}`;
    const s2 = await V.autoReconcile({ force: true });
    expect([s2?.ok, s2?.count, s2?.mismatches[0]?.ledger, s2?.mismatches[0]?.balance]).toEqual([false, 1, 4, 5]);
    expect(await db.auditLog.count({ where: { action: 'stock.reconcile_mismatch' } })).toBe(1);
    const a = await V.reconcileAlert(['SUPER_ADMIN']);
    expect([a?.kind, a?.status?.count]).toEqual(['mismatch', 1]);
    expect(await V.reconcileAlert(['ADMIN', 'WAREHOUSE'])).toBeNull();
    // Дахин шалгахад зөрүү хэвээр бол түүхэнд дахин бичихгүй, «since» хэвээр
    const s3 = await V.autoReconcile({ force: true });
    expect([s3?.since, await db.auditLog.count({ where: { action: 'stock.reconcile_mismatch' } })]).toEqual([s2?.since, 1]);
    await db.$executeRaw`UPDATE "StockBalance" SET qty = qty - 1 WHERE "locationId" = ${dl} AND "variantId" = ${v1}`;
    const rec = await V.reconcile(sa, { fresh: true }); // «Дахин шалгах» товч мөн хадгалсан төлөвийг шинэчилнэ
    expect(rec.ok).toBe(true);
    expect(await db.auditLog.count({ where: { action: 'stock.reconcile_ok' } })).toBe(1);
    expect(await V.reconcileAlert(['SUPER_ADMIN'])).toBeNull();
  });

  it('автомат шалгалт 3+ цаг ажиллаагүй бол Супер админд анхааруулна', async () => {
    const st = await V.autoReconcile({ force: true }); // анхааруулгын кэшийг цэвэрлэнэ
    await db.appSetting.update({ where: { key: V.RECONCILE_KEY }, data: { value: { ...st!, at: new Date(Date.now() - 4 * 3600_000).toISOString() } } });
    const a = await V.reconcileAlert(['SUPER_ADMIN']);
    expect(a?.kind).toBe('stale');
  });
});
