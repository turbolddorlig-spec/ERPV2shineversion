import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';
import { bankPay } from '../helpers/bankPay';

/** Аудит #155 — үлдсэн 9 хуудас: бараа, жолоочийн хяналт, асуудал, төлсөн ч цуцлагдсан, СА цуцлах, тохиргоо, хэрэглэгч, нэвтрэх */
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
let S: typeof import('@/lib/services/accounting/settle');
let X: typeof import('@/lib/services/accounting/extras');
let C: typeof import('@/lib/services/accounting/calc');
let DB: typeof import('@/lib/services/accounting/debts');
beforeAll(async () => {
  S = await import('@/lib/services/accounting/settle');
  X = await import('@/lib/services/accounting/extras');
  C = await import('@/lib/services/accounting/calc');
  DB = await import('@/lib/services/accounting/debts');
});
const pending = async (u: UserActor) => db.companyDebt.findMany({ where: { driverId: u.id, status: 'PENDING', kind: 'GOODS_NOT_RETURNED' }, orderBy: { id: 'asc' } });
const gv = async (u: UserActor) => Object.fromEntries((await G.goodsView(u.id)).items.map((i) => [i.variantId, { bal: i.balance, held: i.held, ret: i.returnable, extra: i.extra, sold: i.sold }]));

/** 1 захиалга (v1×1) + нэмэлт бараа (v2×3) → падаан → жолооч хүлээн авна */
async function withExtras(driver: UserActor, extra = 3) {
  const ids = [(await O.createOrder(op, ub({ deliveryDate: today, lines: [{ variantId: v1, qty: 1 }] }))).order.id];
  await L.assignOrders(lead, { ids, driverId: driver.id });
  const rq = await G.extraTake(driver, { lines: [{ variantId: v2, qty: extra }], idemKey: key() });
  const h = await H.createHandover(wh, { driverId: driver.id, date: today, orderIds: ids });
  await H.prepareHandover(wh, h.id); await checkAll(h.id); await H.setCheck(wh, h.id, { variantId: v2, checked: true, kind: 'EXTRA' });
  await H.confirmHandover(wh, h.id);
  await H.setDriverCheck(driver, h.id, { variantId: 'all', checked: true }); await H.setDriverCheck(driver, h.id, { variantId: v2, checked: true, kind: 'EXTRA' });
  await H.receiveHandover(driver, h.id);
  return { ids, rq, h };
}

describe('#175 Нэмэлт барааны тусдаа тооцоо', () => {
  it('авмагц шууд өр (бүтэн үнээр); зарсан → өр буурч, буцаах жагсаалтаас гарна; агуулах зарсныг авахгүй; «Нэмэлт бараа» тэмдэг', async () => {
    await withExtras(drv, 3);
    let d = await pending(drv);
    expect(d.map((x) => [x.variantId, x.qty, x.amount])).toEqual([[v2, 3, 30000]]);
    expect(d[0]!.description).toContain('Нэмэлт бараа');
    expect((await gv(drv))[v2]).toEqual({ bal: 3, held: 0, ret: 3, extra: 3, sold: 0 });
    await G.extraSale(drv, { lines: [{ variantId: v2, qty: 2 }], payment: 'CASH', idemKey: key() });
    d = await pending(drv);
    expect(d.map((x) => [x.qty, x.amount])).toEqual([[1, 10000]]);
    expect((await gv(drv))[v2]).toEqual({ bal: 3, held: 0, ret: 1, extra: 1, sold: 2 });
    // Агуулахын самбар: буцаах 1 (зарсан 2 нь биш), v1 хүргэлтэд
    const b = (await G.returnsBoard(wh)).items.find((x) => x.driverId === drv.id)!;
    expect([b.balance, b.returnable]).toEqual([4, 1]);
    const dr = await G.driverReturnable(wh, drv.id);
    expect(dr.items.find((i) => i.variantId === v2)).toMatchObject({ returnable: 1, extra: 1 });
    await err(G.receiveReturn(wh, { driverId: drv.id, lines: [{ variantId: v2, qty: 2 }], idemKey: key() }), 409, 'too_many');
    await err(G.extraSale(drv, { lines: [{ variantId: v2, qty: 2 }], payment: 'CASH', idemKey: key() }), 409, 'too_many');
    // Жолоочийн хяналт: буцаах = гарт − хүргэлтэд − зарсан
    expect((await G.driverControl(sa)).items.find((x) => x.id === drv.id)).toMatchObject({ goods: 4, returnable: 1 });
    // Үлдсэн 1-ийг агуулахад буцаавал өр хаагдана
    await G.receiveReturn(wh, { driverId: drv.id, lines: [{ variantId: v2, qty: 1 }], idemKey: key() });
    expect(await pending(drv)).toEqual([]);
    // Өдрийн эцэс: зарсан бараа өр болохгүй
    await DB.closeShortagesNow(sa, drv.id);
    expect(await pending(drv)).toEqual([]);
    await recOk();
  });

  it('«Үйлчлүүлэгч буцаасан»: өр буцаж нэмэгдэнэ, бараа дахин «буцаах»; тооцоо хийсний дараа болохгүй; өөр жолоочийнхыг болохгүй', async () => {
    await withExtras(drv, 3);
    const s = await G.extraSale(drv, { lines: [{ variantId: v2, qty: 3 }], payment: 'BANK', idemKey: key() });
    expect(await pending(drv)).toEqual([]);
    await err(G.extraSaleUndo(drv2, s.doc.id), 400);
    await err(G.extraSaleUndo(op, s.doc.id), 403);
    await G.extraSaleUndo(drv, s.doc.id);
    await G.extraSaleUndo(drv, s.doc.id); // давхар дарахад нэг л удаа
    expect((await db.driverDoc.findUniqueOrThrow({ where: { id: s.doc.id } })).status).toBe('CANCELLED');
    expect((await pending(drv)).map((x) => [x.qty, x.amount])).toEqual([[3, 30000]]);
    expect((await gv(drv))[v2]).toMatchObject({ ret: 3, sold: 0 });
    const s2 = await G.extraSale(drv, { lines: [{ variantId: v2, qty: 1 }], payment: 'CASH', idemKey: key() });
    await X.settleExtras(acc, { driverId: drv.id, date: today });
    await err(G.extraSaleUndo(drv, s2.doc.id), 409, 'already_settled');
    const logs = await db.auditLog.findMany({ where: { action: { in: ['driver.extra_sale_returned', 'extras.settled', 'debt.extra_created'] } } });
    expect(new Set(logs.map((l) => l.action))).toEqual(new Set(['driver.extra_sale_returned', 'extras.settled', 'debt.extra_created']));
    await recOk();
  });

  it('нягтлан: жолооч хүсэлт илгээгээгүй ч самбарт; хөлс = ширхэг × тэр өдрийн хөлс (Онцгой); «Нэмэлтийн мөнгө авсан» → бараа журналаар гарна, үндсэн тооцоонд нийлэхгүй', async () => {
    await err(S.setPayMode(sa, { driverId: drv.id, mode: 'EXCEPTIONAL' }), 400, 'rate_required');
    await err(S.setPayMode(sa, { driverId: drv.id, mode: 'EXCEPTIONAL', rate: 100 }), 400, 'rate_required');
    const pm = await S.setPayMode(sa, { driverId: drv.id, mode: 'EXCEPTIONAL', rate: 2500 });
    expect(pm.message).toContain('онцгой');
    const { ids } = await withExtras(drv, 3);
    await DR.deliverOrder(drv, ids[0]!, { payment: 'CASH' });
    await G.extraSale(drv, { lines: [{ variantId: v2, qty: 2 }], payment: 'CASH', idemKey: key() });
    const day0 = await C.computeDriverDay(db, today, drv.id);
    expect([day0.mode, day0.rate, day0.tier, day0.salary, day0.toReceive]).toEqual(['EXCEPTIONAL', 2500, 'exceptional', 2500, 7500]);
    const board = await S.accountingDay(acc, today);
    const ex = board.extras.items.find((x) => x.driverId === drv.id)!;
    expect([ex.taken, ex.open.pieces, ex.open.amount, ex.open.fee, ex.open.receive, ex.open.rate, ex.toReturn]).toEqual([3, 2, 20000, 5000, 15000, 2500, 1]);
    expect(board.extras.totals.openReceive).toBe(15000);
    expect(board.kpi.toReceive).toBe(7500); // үндсэн тооцоо өөрчлөгдөхгүй
    await err(X.settleExtras(drv, { driverId: drv.id, date: today }), 403);
    await err(X.settleExtras(op, { driverId: drv.id, date: today }), 403);
    const loc = await drvLoc(drv);
    const r = await X.settleExtras(acc, { driverId: drv.id, date: today });
    expect([r.pieces, r.amount, r.fee, r.receive, r.duplicate]).toEqual([2, 20000, 5000, 15000, false]);
    expect((await X.settleExtras(acc, { driverId: drv.id, date: today })).duplicate).toBe(true);
    expect(await bal(loc, v2)).toBe(1);
    const doc = await db.driverDoc.findFirstOrThrow({ where: { driverId: drv.id, kind: 'EXTRA_SALE' } });
    expect([doc.status, doc.fee, doc.settledByName]).toEqual(['DONE', 5000, acc.name]);
    const b2 = await S.accountingDay(acc, today);
    const ex2 = b2.extras.items.find((x) => x.driverId === drv.id)!;
    expect([ex2.open.pieces, ex2.settled.pieces, ex2.settled.amount, ex2.settled.fee, ex2.settled.receive]).toEqual([0, 2, 20000, 5000, 15000]);
    expect([b2.kpi.toReceive, b2.kpi.extraSale]).toEqual([7500, 0]);
    // Зараагүй 1 — өр бүтэн үнээр
    expect((await pending(drv)).map((x) => [x.qty, x.amount])).toEqual([[1, 10000]]);
    await recOk();
  });

  it('хэд хоногийн зарсан ч алга болохгүй (өмнөх өдрийн хөлсөөр); стресс — олон жолооч, зэрэг дарахад үлдэгдэл 0 зөрүү', async () => {
    await H.setTrusted(acc, { driverId: drv2.id, trusted: true });
    await withExtras(drv, 3); await withExtras(drv2, 2);
    const s = await G.extraSale(drv, { lines: [{ variantId: v2, qty: 1 }], payment: 'CASH', idemKey: key() });
    await db.driverDoc.update({ where: { id: s.doc.id }, data: { createdAt: new Date(Date.now() - 2 * 86_400_000) } });
    await G.extraSale(drv, { lines: [{ variantId: v2, qty: 1 }], payment: 'CASH', idemKey: key() });
    await G.extraSale(drv2, { lines: [{ variantId: v2, qty: 2 }], payment: 'BANK', idemKey: key() });
    const ex = (await X.extrasBoard(acc, today)).items.find((x) => x.driverId === drv.id)!;
    expect([ex.open.docs, ex.open.pieces]).toEqual([2, 2]);
    await Promise.all([X.settleExtras(acc, { driverId: drv.id, date: today }), X.settleExtras(acc, { driverId: drv.id, date: today }), X.settleExtras(sa, { driverId: drv2.id, date: today })]);
    expect(await db.driverDoc.count({ where: { kind: 'EXTRA_SALE', status: 'DONE' } })).toBe(3);
    expect(await db.stockMove.count({ where: { type: 'EXTRA_SALE' } })).toBe(3);
    expect(await bal(await drvLoc(drv2), v2)).toBe(0);
    await recOk();
  });
});
