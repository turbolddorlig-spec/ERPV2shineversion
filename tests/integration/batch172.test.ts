import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';
import { bankPay } from '../helpers/bankPay';

/** #172 — эзний 8 хүсэлт: нягтлан бараа хасах (өр), ижил хаяг, хүлээгдэж буйд огноогүй, цуцлах тайлбар, өнөөдрийн тоо, дуудлагын огноо */
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

let S: typeof import('@/lib/services/accounting/settle');
let Q: typeof import('@/lib/services/orders/queries');
let C: typeof import('@/lib/services/orders/calls');
beforeAll(async () => {
  S = await import('@/lib/services/accounting/settle');
  Q = await import('@/lib/services/orders/queries');
  C = await import('@/lib/services/orders/calls');
});
const debts = (driverId: string) => db.companyDebt.findMany({ where: { driverId, kind: 'GOODS_NOT_RETURNED', status: 'PENDING' } });

describe('#172-1 нягтлан хүргэсэн захиалгаас бараа хасах', () => {
  it('3 бараанаас 1-ийг хасна → дүн буурна, тэр дороо жолоочид өр; агуулахад өгөхөд өр хаагдана; тулгалт 0', async () => {
    const [id] = await outFor(drv, 1, [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 1 }]) as [number];
    await DR.deliverOrder(drv, id, { payment: 'CASH' });
    const o = await db.order.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { id: 'asc' } } } });
    const l1 = o.lines.find((l) => l.variantId === v1)!;
    await err(S.returnOrderLines(op, id, { lines: [{ lineId: l1.id, qty: 1 }], note: 'Үйлчлүүлэгч авахгүй гэсэн' }), 403);
    await err(S.returnOrderLines(acc, id, { lines: [{ lineId: l1.id, qty: 3 }], note: 'Үйлчлүүлэгч авахгүй гэсэн' }), 400);
    await err(S.returnOrderLines(acc, id, { lines: o.lines.map((l) => ({ lineId: l.id, qty: l.qty })), note: 'Бүгдийг хасах оролдлого' }), 409);
    await S.returnOrderLines(acc, id, { lines: [{ lineId: l1.id, qty: 1 }], note: 'Үйлчлүүлэгч 1 барааг авахгүй гэсэн' });
    const u = await db.order.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    expect(u.status).toBe('DELIVERED');
    expect(u.total).toBe(o.total - l1.unitPrice);
    expect(u.collectAmount).toBe(u.total);
    expect(u.lines.find((l) => l.id === l1.id)!.refusedQty).toBe(1);
    const d = await debts(drv.id);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ variantId: v1, qty: 1, amount: l1.unitPrice });
    expect(await drvLoc(drv)).toBeGreaterThan(0);
    expect(await bal(await drvLoc(drv), v1)).toBe(1);
    await recOk();
    // Жолооч агуулахад өгөхөд өр автоматаар хаагдана
    await G.receiveReturn(wh, { driverId: drv.id, lines: [{ variantId: v1, qty: 1 }], idemKey: key() });
    expect(await debts(drv.id)).toHaveLength(0);
    await recOk();
  });

  it('тооцоо түгжсэн өдөрт хасахгүй', async () => {
    const [id] = await outFor(drv, 1, [{ variantId: v1, qty: 2 }]) as [number];
    await DR.deliverOrder(drv, id, { payment: 'CASH' });
    const o = await db.order.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    const d = await S.accountingDriver(acc, drv.id, today);
    await S.forceCloseSettlement(acc, { driverId: drv.id, date: today, cash: d.day.toReceive, bank: 0, note: 'Тест хаалт' });
    await err(S.returnOrderLines(acc, id, { lines: [{ lineId: o.lines[0]!.id, qty: 1 }], note: 'Түгжсэн өдөр хасах' }), 409);
  });
});

describe('#172-3 «Төлбөр хүлээж буй» он сар өдөргүй', () => {
  it('орон нутаг / урьдчилгаа хүлээх + хол огноо → татгалзана; маргааш болно', async () => {
    const far = U.ubDay(new Date(), 5);
    await err(O.createOrder(op, ub({ province: 'Дархан-Уул', district: undefined, khoroo: undefined, deliveryDate: far })), 400);
    await err(O.createOrder(op, ub({ prepaidWait: true, deliveryDate: far })), 400);
    const ok = (await O.createOrder(op, ub({ prepaidWait: true, deliveryDate: tomorrow }))).order;
    expect(ok.status).toBe('PENDING_PAYMENT');
    // Шинэ (УБ, урьдчилгаагүй) он сар өдөртэй хэвээр болно
    expect((await O.createOrder(op, ub({ deliveryDate: far }))).order.status).toBe('NEW');
  });
});

describe('#172-4 цуцлах — шалтгаан сонгосон бол тайлбар заавал биш', () => {
  it('«Үйлчлүүлэгч болисон» тайлбаргүй → цуцлагдана; «Бусад» тайлбаргүй → татгалзана', async () => {
    const a = (await O.createOrder(op, ub())).order;
    const r = await O.cancelOrder(op, a.id, { reason: 'CUSTOMER_CANCELLED' });
    expect(r.order.status).toBe('CANCELLED');
    expect(r.order.cancelNote).toBeTruthy();
    const b = (await O.createOrder(op, ub())).order;
    await err(O.cancelOrder(op, b.id, { reason: 'OTHER' }), 400);
    expect((await O.cancelOrder(op, b.id, { reason: 'OTHER', note: 'Өөр шалтгаан тайлбар' })).order.status).toBe('CANCELLED');
  });
});

describe('#172-5 өнөөдрийн тоо — баталгаажсан өдрөөр', () => {
  it('өчигдөр үүссэн хүлээгдэж буй, өнөөдөр мөнгө орсон → өнөөдрийн тоонд', async () => {
    const p = (await O.createOrder(op, ub({ prepaidWait: true, deliveryDate: tomorrow }))).order;
    await db.order.update({ where: { id: p.id }, data: { createdAt: new Date(Date.now() - 86_400_000 - 3600_000) } });
    Q.bustCounts();
    const before = (await Q.tabCounts()).today ?? 0;
    await bankPay(p.id);
    const after1 = await db.order.findUniqueOrThrow({ where: { id: p.id } });
    expect(after1.status).toBe('NEW');
    Q.bustCounts();
    expect((await Q.tabCounts()).today).toBe(before + 1);
    const list = await Q.listOrders(sa, { tab: 'today' } as never);
    expect((list.items as { id: number }[]).map((x) => x.id)).toContain(p.id);
  });
});

describe('#186 «Өнөөдөр» таб — цуцалсан орохгүй', () => {
  it('өнөөдөр үүссэн захиалгыг цуцлахад тоо ба жагсаалтаас хасагдана, «Цуцлагдсан» табд үлдэнэ', async () => {
    const a = (await O.createOrder(op, ub({}))).order;
    Q.bustCounts();
    const before = (await Q.tabCounts()).today ?? 0;
    expect((await Q.listOrders(sa, { tab: 'today' } as never)).items.map((x: { id: number }) => x.id)).toContain(a.id);
    await O.cancelOrder(op, a.id, { reason: 'DUPLICATE' });
    Q.bustCounts();
    expect((await Q.tabCounts()).today).toBe(before - 1);
    expect((await Q.listOrders(sa, { tab: 'today' } as never)).items.map((x: { id: number }) => x.id)).not.toContain(a.id);
    expect((await Q.listOrders(sa, { tab: 'CANCELLED' } as never)).items.map((x: { id: number }) => x.id)).toContain(a.id);
  });
});

describe('#172-2 ижил хаяг өөр утсанд', () => {
  it('идэвхтэй захиалга ижил хаягтай (зай, том жижиг үсэг харгалзахгүй) → анхааруулга; ижил утас эсвэл цуцлагдсан бол үгүй', async () => {
    const a = (await O.createOrder(op, ub({ addressDetail: 'Баянзүрх 45-р байр 2-р орц 56 тоот' }))).order;
    const m = await Q.addressMatches(op, { province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: '  баянзүрх 45-р байр   2-р орц 56 тоот ', phones: ['99999999'] });
    expect(m.items.map((x) => x.number)).toEqual([a.number]);
    expect((await Q.addressMatches(op, { province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Баянзүрх 45-р байр 2-р орц 56 тоот', phones: [a.phone] })).items).toEqual([]);
    expect((await Q.addressMatches(op, { province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 12, addressDetail: 'Баянзүрх 45-р байр 2-р орц 56 тоот', phones: [] })).items).toEqual([]);
    await O.cancelOrder(op, a.id, { reason: 'DUPLICATE' });
    expect((await Q.addressMatches(op, { province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Баянзүрх 45-р байр 2-р орц 56 тоот', phones: [] })).items).toEqual([]);
  });
});

describe('#172-6 дуудлагын бүртгэл огноогоор', () => {
  it('«Бүх оператор» + эхлэх–дуусах огноо', async () => {
    const lead2 = await actor(['OPERATOR_LEAD']);
    await C.createCallNotes(op, { phones: ['88001122'], note: 'өнөөдрийн' });
    await C.createCallNotes(op, { phones: ['88003344'], note: 'хуучин' });
    await db.callNote.updateMany({ where: { phone: '88003344' }, data: { createdAt: new Date(Date.now() - 5 * 86_400_000) } });
    const t = await C.listCallNotes(lead2, { scope: 'all', from: today, to: today });
    expect(t.items.map((x) => x.phone)).toEqual(['88001122']);
    const all = await C.listCallNotes(lead2, { scope: 'all', from: U.ubDay(new Date(), -10), to: today });
    expect(all.items.map((x) => x.phone).sort()).toEqual(['88001122', '88003344']);
  });
});
