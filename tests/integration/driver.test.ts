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

describe('хүргэсэн', () => {
  it('бүтэн, Бэлэн: бараа жолоочоос гарна, дүн жолоочид; давхар дарахад нэг удаа; өөр жолооч / падаангүй бол болохгүй', async () => {
    const [id] = await outFor(drv);
    const main = await locOf(mainWh);
    const before = await bal(main, v1);
    await err(DR.deliverOrder(drv2, id, { payment: 'CASH' }), 404);
    await err(DR.deliverOrder(op, id, { payment: 'CASH' }), 403);
    await err(DR.deliverOrder(drv, id, {}), 400, 'payment_required');
    const rs = await Promise.all([DR.deliverOrder(drv, id, { payment: 'CASH' }), DR.deliverOrder(drv, id, { payment: 'CASH' })]);
    expect(rs.map((r) => r.duplicate).sort()).toEqual([false, true]);
    const o = await db.order.findUniqueOrThrow({ where: { id } });
    expect([o.status, o.deliveryPayment, o.collectAmount, o.total, o.originalTotal]).toEqual(['DELIVERED', 'CASH', 30000, 30000, 30000]);
    expect(await goods(drv)).toEqual({});
    expect(await bal(main, v1)).toBe(before); // агуулах хөдлөхгүй (падаанаар аль хэдийн гарсан)
    expect(await db.stockMove.count({ where: { type: 'DELIVERY' } })).toBe(2);
    // Падаан өгөөгүй захиалга
    const a = (await O.createOrder(op, ub({ deliveryDate: tomorrow }))).order;
    await L.assignOrders(lead, { ids: [a.id], driverId: drv.id });
    await err(DR.deliverOrder(drv, a.id, { payment: 'CASH' }), 409, 'not_handed_over');
    await recOk();
  });

  it('хэсэгчилсэн: болиулсан барааг чагтаа авна → дүн дахин бодогдоно, болиулсан бараа жолоочид буцаахаар; бүгдийг болиулбал алдаа', async () => {
    const [id] = await outFor(drv);
    const l1 = await lineOf(id, v1); const l2 = await lineOf(id, v2);
    await err(DR.deliverOrder(drv, id, { payment: 'CASH', taken: { [l1]: 0, [l2]: 0 } }), 400, 'nothing_taken');
    await err(DR.deliverOrder(drv, id, { payment: 'CASH', taken: { [l1]: 3 } }), 400);
    await DR.deliverOrder(drv, id, { payment: 'BANK', taken: { [l1]: 1, [l2]: 0 } });
    const o = await db.order.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    expect([o.total, o.subtotal, o.originalTotal, o.collectAmount, o.deliveryPayment]).toEqual([10000, 10000, 30000, 10000, 'BANK']);
    expect(o.lines.map((l) => [l.variantId, l.refusedQty]).sort()).toEqual([[v1, 1], [v2, 1]].sort());
    expect(await goods(drv)).toEqual({ [v1]: [1, 0, 1], [v2]: [1, 0, 1] });
    await recOk();
  });

  it('урьдчилж төлсөн: тайлбар заавал, жолооч мөнгө авахгүй; Төлөөгүй = өр', async () => {
    const [a, b] = await outFor(drv, 2);
    await db.order.update({ where: { id: a }, data: { prepaid: true } });
    await err(DR.deliverOrder(drv, a, { payment: 'CASH' }), 400, 'note_required');
    await DR.deliverOrder(drv, a, { note: 'Дансаар урьдчилж төлсөн' });
    await DR.deliverOrder(drv, b, { payment: 'UNPAID' });
    const [oa, ob] = await Promise.all([db.order.findUniqueOrThrow({ where: { id: a } }), db.order.findUniqueOrThrow({ where: { id: b } })]);
    expect([oa.deliveryPayment, oa.collectAmount, ob.deliveryPayment, ob.collectAmount]).toEqual(['PREPAID', 0, 'UNPAID', 0]);
    const list = await DR.driverOrders(drv, 'delivered');
    expect(list.money).toEqual({ cash: 0, bank: 0, unpaid: 30000, prepaid: 30000 });
  });

  it('«Цуцлах (буцаах)» → бараа жолоочид; «Хүргэсэн болгох» бараа жолоочид байхад л; агуулахад буцсаны дараа болохгүй (давхар хасалтгүй)', async () => {
    const [id] = await outFor(drv);
    const l1 = await lineOf(id, v1);
    await DR.deliverOrder(drv, id, { payment: 'CASH', taken: { [l1]: 1 } });
    await err(DR.undoDelivery(drv, id, { note: 'abc' }), 400);
    await DR.undoDelivery(drv, id, { note: 'Үйлчлүүлэгч буцааж өгсөн' });
    let o = await db.order.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    expect([o.status, o.cancelReason, o.total, o.lines.every((l) => l.refusedQty === 0)]).toEqual(['CANCELLED', 'DRIVER_CANCELLED', 30000, true]);
    expect(await goods(drv)).toEqual({ [v1]: [2, 0, 2], [v2]: [1, 0, 1] });
    await DR.deliverOrder(drv, id, { payment: 'CASH' });
    o = await db.order.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    expect([o.status, o.cancelReason, o.total]).toEqual(['DELIVERED', null, 30000]);
    await DR.undoDelivery(drv, id, { note: 'Дахин буцаасан тест' });
    await G.receiveReturn(wh, { driverId: drv.id, lines: [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 1 }], idemKey: key() });
    await err(DR.deliverOrder(drv, id, { payment: 'CASH' }), 409, 'goods_not_with_driver');
    await recOk();
  });
});

describe('цуцлах, маргааш', () => {
  it('цуцлах: хүргэлтэд бол бараа жолоочид; падаан өгөөгүй бол нөөц суллагдаж падаанаас хасагдана; «Мөнгө өгдөггүй хүн» → хар жагсаалт', async () => {
    const [a] = await outFor(drv);
    await err(DR.driverCancel(drv, a, { note: 'abc' }), 400);
    await DR.driverCancel(drv, a, { note: 'Утсаа авахгүй байна', blacklist: true });
    const oa = await db.order.findUniqueOrThrow({ where: { id: a } });
    expect([oa.status, oa.cancelReason, oa.driverId]).toEqual(['CANCELLED', 'DRIVER_CANCELLED', drv.id]);
    expect(await db.blacklistEntry.count({ where: { phone: oa.phone, isActive: true } })).toBe(1);
    expect(await goods(drv)).toEqual({ [v1]: [2, 0, 2], [v2]: [1, 0, 1] });
    // Падаан өгөөгүй (Бэлдэж байна)
    const b = (await O.createOrder(op, ub({ deliveryDate: tomorrow }))).order.id;
    await L.assignOrders(lead, { ids: [b], driverId: drv.id });
    const h = await H.createHandover(wh, { driverId: drv.id, date: tomorrow, orderIds: [b] });
    expect(await db.stockReservation.count({ where: { orderId: b } })).toBe(1);
    // #77 (хуучин шиг): падаанаа хүлээн авахаас өмнө жолооч цуцлах/маргааш/асуудал дарахгүй — карт зөвхөн хаягтай
    await err(DR.driverCancel(drv, b, { note: 'Үйлчлүүлэгч болисон' }), 409, 'not_received');
    await err(DR.postponeOrder(drv, b, {}), 409, 'not_received');
    await err(DR.reportIssue(drv, b, { type: 'WRONG_NUMBER' }), 409, 'not_received');
    const card = (await DR.driverOrders(drv, 'tomorrow')).items.find((x) => x.id === b)!;
    expect([card.goodsHidden, card.lines.length, card.total, Object.values(card.can).some(Boolean)]).toEqual([true, 0, 0, false]);
    expect(await db.stockReservation.count({ where: { orderId: b } })).toBe(1);
    expect((await db.handoverOrder.findFirstOrThrow({ where: { handoverId: h.id, orderId: b } })).removedAt).toBeNull();
    await recOk();
  });

  it('маргааш: ижил дугаар «Шинэ», маргааш, жолоочгүй, агуулахад нөөц; бараа жолоочид → дурын жолоочид оноож, буцаалтын дараа шинэ падаанаар; тулгалт 0', async () => {
    const [id] = await outFor(drv);
    const number = (await db.order.findUniqueOrThrow({ where: { id } })).number;
    await DR.postponeOrder(drv, id, {});
    let o = await db.order.findUniqueOrThrow({ where: { id } });
    expect([o.number, o.status, U.ymdOf(o.deliveryDate), o.driverId, o.postponeCount, o.postponedByDriverId, o.handoverId]).toEqual([number, 'NEW', tomorrow, null, 1, drv.id, null]);
    expect(await db.stockReservation.count({ where: { orderId: id } })).toBe(2);
    expect(await goods(drv)).toEqual({ [v1]: [2, 0, 2], [v2]: [1, 0, 1] });
    expect((await DR.driverOrders(drv, 'tomorrow')).items.map((x) => x.id)).toEqual([id]);
    // Бараа буцахаас өмнө өөр жолоочид оноож болно (#73 1)
    await H.setTrusted(acc, { driverId: drv2.id, trusted: true });
    await L.assignOrders(lead, { ids: [id], driverId: drv2.id });
    o = await db.order.findUniqueOrThrow({ where: { id } });
    expect([o.status, o.driverId, U.ymdOf(o.deliveryDate)]).toEqual(['ASSIGNED', drv2.id, tomorrow]);
    // Орой буцаалт → маргааш drv2-д шинэ падаан
    await G.receiveReturn(wh, { driverId: drv.id, lines: [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 1 }], idemKey: key() });
    expect(await goods(drv)).toEqual({});
    const h2 = await H.createHandover(wh, { driverId: drv2.id, date: tomorrow, orderIds: [id] });
    await H.prepareHandover(wh, h2.id); await checkAll(h2.id); await H.confirmHandover(wh, h2.id);
    await H.setDriverCheck(drv2, h2.id, { variantId: 'all', checked: true }); await H.receiveHandover(drv2, h2.id);
    expect(await goods(drv2)).toEqual({ [v1]: [2, 2, 0], [v2]: [1, 1, 0] });
    await DR.deliverOrder(drv2, id, { payment: 'CASH' });
    await recOk();
  });

  it('маргааш 2 удаа, дараа нь цоож; андуурсан бол өнөөдөр буцаах (бараа жолоочид, падааны мөр сэргэнэ)', async () => {
    const [id] = await outFor(drv);
    await DR.postponeOrder(drv, id, {});
    await DR.undoPostpone(drv, id);
    let o = await db.order.findUniqueOrThrow({ where: { id } });
    expect([o.status, o.driverId, o.postponeCount, U.ymdOf(o.deliveryDate), o.handoverId !== null]).toEqual(['OUT_FOR_DELIVERY', drv.id, 0, today, true]);
    expect(await db.stockReservation.count({ where: { orderId: id } })).toBe(0);
    expect(await goods(drv)).toEqual({ [v1]: [2, 2, 0], [v2]: [1, 1, 0] });
    await DR.postponeOrder(drv, id, {});
    await L.assignOrders(lead, { ids: [id], driverId: drv.id }); // өнөөдрийн падаан өгөгдсөн → маргааш
    await err(DR.undoPostpone(drv, id), 409, 'already_reassigned');
    await handTo(drv, tomorrow, [id]);
    await DR.postponeOrder(drv, id, {}); // 2 дахь
    o = await db.order.findUniqueOrThrow({ where: { id } });
    expect([o.status, o.postponeCount]).toEqual(['NEW', 2]);
    const r = await L.assignOrders(lead, { ids: [id], driverId: drv.id }); // маргаашийн падаан ч өгөгдсөн → нөгөөдөр
    await handTo(drv, r.assigned[0]!.date, [id]);
    await err(DR.postponeOrder(drv, id, {}), 409, 'postpone_locked');
    await recOk();
  });
});

describe('асуудал, буцаалт, нэмэлт бараа, pickup, хяналт', () => {
  it('«Опп-руу явуулах»: шийдэгдэх хүртэл товч түгжээтэй; «Зассан» → үргэлжлүүлнэ; «Цуцлах» → хэний алдаа, бараа жолоочид', async () => {
    const [a, b] = await outFor(drv, 2);
    const olead = await actor(['OPERATOR_LEAD']);
    await err(DR.reportIssue(drv, a, { type: 'BAD' }), 400);
    await DR.reportIssue(drv, a, { type: 'WRONG_NUMBER', note: 'Утас холбогдохгүй' });
    await err(DR.deliverOrder(drv, a, { payment: 'CASH' }), 409, 'issue_pending');
    await err(DR.resolveIssue(op, a, { action: 'fix', note: 'Зөв утас 99112233' }), 403);
    expect((await DR.listIssues(op, {})).items.map((x) => x.id)).toEqual([a]);
    await DR.resolveIssue(olead, a, { action: 'fix', note: 'Зөв утас 99112233' });
    await DR.deliverOrder(drv, a, { payment: 'CASH' });
    await DR.reportIssue(drv, b, { type: 'UNCLEAR_ADDRESS' });
    await err(DR.resolveIssue(olead, b, { action: 'cancel', note: 'Хаяг олдохгүй' }), 400, 'fault_required');
    await DR.resolveIssue(olead, b, { action: 'cancel', note: 'Хаяг олдохгүй', fault: 'OPERATOR' });
    const ob = await db.order.findUniqueOrThrow({ where: { id: b } });
    expect([ob.status, ob.cancelReason, ob.issueStatus, ob.issueFault]).toEqual(['CANCELLED', 'ISSUE', 'CANCELLED', 'OPERATOR']);
    expect(await goods(drv)).toEqual({ [v1]: [2, 0, 2], [v2]: [1, 0, 1] });
    await recOk();
  });

  it('буцаалт хүлээн авах: буцаахаас илүүг болохгүй, хүргэлтийн барааг авахгүй, дутуу нь жолоочид үлдэнэ, давхар дарахад нэг удаа, зэрэг', async () => {
    const [a] = await outFor(drv, 2);
    await DR.driverCancel(drv, a, { note: 'Үйлчлүүлэгч болисон' }); // буцаах: v1 2, v2 1; нөгөө захиалга хүргэлтэд
    expect(await goods(drv)).toEqual({ [v1]: [4, 2, 2], [v2]: [2, 1, 1] });
    await err(G.receiveReturn(wh, { driverId: drv.id, lines: [{ variantId: v1, qty: 3 }], idemKey: key() }), 409, 'too_many');
    await err(G.receiveReturn(op, { driverId: drv.id, lines: [{ variantId: v1, qty: 1 }], idemKey: key() }), 403);
    const main = await locOf(mainWh);
    const b0 = await bal(main, v1);
    const k = key();
    const rs = await Promise.all([G.receiveReturn(wh, { driverId: drv.id, lines: [{ variantId: v1, qty: 1 }], idemKey: k }), G.receiveReturn(wh, { driverId: drv.id, lines: [{ variantId: v1, qty: 1 }], idemKey: k })]);
    expect(await db.driverDoc.count()).toBe(1);
    expect(rs.length).toBe(2);
    expect(await bal(main, v1)).toBe(b0 + 1);
    expect(await goods(drv)).toEqual({ [v1]: [3, 2, 1], [v2]: [2, 1, 1] });
    // Зэрэг 2 өөр түлхүүрээр үлдсэнээс илүүг → нэг нь л
    const two = await Promise.allSettled([1, 2].map(() => G.receiveReturn(wh, { driverId: drv.id, lines: [{ variantId: v1, qty: 1 }], idemKey: key() })));
    expect(two.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await G.returnsBoard(wh)).items.find((x) => x.driverId === drv.id)?.returnable).toBe(1);
    await recOk();
  });

  it('нэмэлт бараа: захиалгын нөөцөд хүрэхгүй; зарахад системийн үнэ, буцаах бараанаас л; үлдсэнийг буцаана', async () => {
    const [id] = await outFor(drv); // v1 2 жолоочид хүргэлтэд
    const av = (await P.searchVariants(op, 'G1')).find((x) => x.variantId === v1)!.available;
    await err(G.extraTake(drv, { lines: [{ variantId: v1, qty: av + 1 }], idemKey: key() }), 409, 'insufficient_stock');
    await err(G.extraTake(op, { lines: [{ variantId: v1, qty: 1 }], idemKey: key() }), 403);
    await G.extraTake(drv, { lines: [{ variantId: v1, qty: 3 }], idemKey: key() });
    expect(await goods(drv)).toEqual({ [v1]: [5, 2, 3], [v2]: [1, 1, 0] });
    await err(G.extraSale(drv, { lines: [{ variantId: v1, qty: 4 }], payment: 'CASH', idemKey: key() }), 409, 'too_many');
    await err(G.extraSale(drv, { lines: [{ variantId: v2, qty: 1 }], payment: 'CASH', idemKey: key() }), 409, 'too_many'); // хүргэлтийн бараа
    const s = await G.extraSale(drv, { lines: [{ variantId: v1, qty: 2 }], payment: 'CASH', idemKey: key(), note: 'Хөршид' });
    expect([s.doc.total, s.doc.kind]).toEqual([20000, 'EXTRA_SALE']);
    await DR.deliverOrder(drv, id, { payment: 'CASH' });
    await G.receiveReturn(wh, { driverId: drv.id, lines: [{ variantId: v1, qty: 1 }], idemKey: key() });
    expect(await goods(drv)).toEqual({});
    const c = await G.driverControl(sa);
    expect(c.items.find((x) => x.id === drv.id)).toMatchObject({ delivered: 1, cash: 30000, extraSales: 20000, goods: 0, returnable: 0 });
    await recOk();
  });

  it('pickup: жолооч хуваарилаагүй «Шинэ»-г өөрөө авна; өөр жолоочийнхыг авахгүй; хяналт ба жолоочийн табууд', async () => {
    const a = (await O.createOrder(op, ub({ deliveryDate: today }))).order.id;
    const b = (await O.createOrder(op, ub({ deliveryDate: today }))).order.id;
    await L.assignOrders(lead, { ids: [b], driverId: drv2.id });
    expect((await DR.pickupList(drv, {})).items.map((x) => x.id)).toEqual([a]);
    const r = await DR.pickUp(drv, { ids: [a, b] });
    expect([r.assigned.map((x) => x.id), r.skipped.map((x) => x.id)]).toEqual([[a], [b]]);
    expect((await db.order.findUniqueOrThrow({ where: { id: a } })).driverId).toBe(drv.id);
    expect(await db.auditLog.count({ where: { action: 'order.picked_up' } })).toBe(1);
    const all = await DR.driverOrders(drv, 'all');
    expect(all.items.map((x) => [x.id, x.can.deliver, x.can.postpone, x.goodsHidden])).toEqual([[a, false, false, true]]);
    const c = await G.driverControl(lead);
    expect(c.items.find((x) => x.id === drv.id)?.assigned).toBe(1);
    await err(G.driverControl(op), 403);
  });

  it('зэрэг: нэг захиалгыг хүргэсэн + цуцлах + маргааш зэрэг дарахад нэг нь л, тулгалт 0', async () => {
    const ids = await outFor(drv, 3);
    for (const id of ids) {
      await Promise.allSettled([DR.deliverOrder(drv, id, { payment: 'CASH' }), DR.driverCancel(drv, id, { note: 'Зэрэг цуцлах' }), DR.postponeOrder(drv, id, {})]);
      const o = await db.order.findUniqueOrThrow({ where: { id } });
      expect(['DELIVERED', 'CANCELLED', 'NEW']).toContain(o.status);
    }
    const g = await G.goodsView(drv.id);
    const out = await db.order.count({ where: { driverId: drv.id, status: 'OUT_FOR_DELIVERY' } });
    expect([out, g.items.every((i) => i.held === 0)]).toEqual([0, true]);
    await recOk();
  });
});

describe('ахлах жолоочийн «Жолоочийн гүйцэтгэл», «График» (#77)', () => {
  it('хүргэсэн/цуцалсан/маргааш тусдаа, амжилт = хүргэсэн ÷ (хүргэсэн + цуцалсан), өдрөөр зөв, эрх', async () => {
    const ids = await outFor(drv, 4);
    await DR.deliverOrder(drv, ids[0], { payment: 'CASH' });
    await DR.deliverOrder(drv, ids[1], { payment: 'BANK' });
    await DR.driverCancel(drv, ids[2], { note: 'Үйлчлүүлэгч болисон' });
    await DR.postponeOrder(drv, ids[3], {});
    const p = await L.leadPerformance(lead, {});
    const me = p.items.find((x) => x.id === drv.id)!;
    expect([me.delivered, me.cancelled, me.postponed, me.total, me.rate, me.revenue]).toEqual([2, 1, 1, 4, 66.7, 60000]);
    expect((await L.leadPerformance(lead, { driverId: drv2.id })).items).toEqual([]);
    const c = await L.leadChart(lead, {});
    expect(c.daily).toHaveLength(14);
    expect(c.daily.at(-1)).toMatchObject({ date: today, delivered: 2, cancelled: 1, postponed: 1, total: 4 });
    expect(c.daily.slice(0, -1).every((d) => d.total === 0)).toBe(true);
    await err(L.leadPerformance(wh, {}), 403);
    await err(L.leadChart(op, {}), 403);
  });
});
