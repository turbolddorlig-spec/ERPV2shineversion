import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';
import { bankPay } from '../helpers/bankPay';

/** Аудит #160 — түгжсэн өдрийн хожуу буцаалт (14 хоног), операторын цалингийн суутгал, 7+ хоног буцаагаагүй бараа */
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



const C = () => import('@/lib/services/accounting/calc');
const S = () => import('@/lib/services/accounting/settle');
const SAL = () => import('@/lib/services/salary');
const half = () => (Number(U.ubDay().slice(8)) <= 15 ? 1 : 2) as 1 | 2;
const nextPeriod = () => { const ym = U.ubDay().slice(0, 7); if (half() === 1) return { ym, half: 2 as const }; const [y, m] = ym.split('-').map(Number) as [number, number]; return { ym: `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`, half: 1 as const }; };
/** Хүргээд тооцоог баталгаажуулна (өдөр түгжигдэнэ) */
async function deliveredLocked(n = 1) {
  const St = await S();
  const ids = await outFor(drv, n);
  for (const id of ids) await DR.deliverOrder(drv, id, { payment: 'CASH' });
  const day = (await (await C()).computeDay(db, today)).find((x) => x.driverId === drv.id)!;
  await St.submitSettlement(drv, { date: today, cash: day.toReceive });
  const s = await db.driverSettlement.findFirstOrThrow({ where: { driverId: drv.id } });
  await St.approveSettlement(acc, s.id);
  return { ids, day };
}

describe('#160 хожуу буцаалт', () => {
  it('түгжсэн өдөр нягтлан «Цуцалсан» болгоно: тооцоо хөдлөхгүй, бараа шууд үндсэн агуулахад (#212), дахин солихгүй; бусад төлөв солих түгжээтэй хэвээр', async () => {
    const St = await S();
    const { ids: [a, b], day } = await deliveredLocked(2);
    const dl = await drvLoc(drv); const before = await bal(dl, v1);
    const ml = await locOf(mainWh); const whBefore = await bal(ml, v1);
    await err(St.toggleOrderStatus(acc, a!, { target: 'CANCELLED' }), 400, 'reason_required');
    await St.toggleOrderStatus(acc, a!, { target: 'CANCELLED', note: 'Үйлчлүүлэгч 7 хоногийн дараа буцаасан' });
    const o = await db.order.findUniqueOrThrow({ where: { id: a! } });
    expect([o.status, !!o.lateCancelledAt, o.deliveryPayment, !!o.deliveredAt]).toEqual(['CANCELLED', true, 'CASH', true]);
    // тэр өдрийн тооцоо хэвээр (хүргэсэн, бэлэн, жолоочийн цалин)
    const day2 = (await (await C()).computeDay(db, today)).find((x) => x.driverId === drv.id)!;
    expect([day2.delivered, day2.cash, day2.salary, day2.toReceive]).toEqual([day.delivered, day.cash, day.salary, day.toReceive]);
    expect((await db.driverSettlement.findFirstOrThrow({ where: { driverId: drv.id } })).status).toBe('COMPLETED');
    // #212: бараа үйлчлүүлэгчээс шууд үндсэн агуулахад (нягтлан хүлээн авсан) — жолоочид бичигдэхгүй, өр үүсэхгүй
    expect(await bal(dl, v1)).toBe(before);
    expect(await bal(ml, v1)).toBe(whBefore + 2);
    expect(await db.companyDebt.count({ where: { driverId: drv.id, kind: 'GOODS_NOT_RETURNED' } })).toBe(0);
    await err(St.toggleOrderStatus(acc, a!, { target: 'DELIVERED', note: 'Буцааж хүргэсэн' }), 409, 'late_returned');
    // түгжсэн өдөр «хүргэсэн» болгох зэрэг бусад өөрчлөлт хориотой хэвээр
    await err(DR.undoDelivery(drv, b!, { note: 'Жолооч оролдов' }), 409);
    await recOk();
  });

  it('#212: 14 хоног өнгөрсөн ч нягтлан, супер админ «Төлөв солих» хийнэ; админ хийхгүй', async () => {
    const St = await S();
    const { ids: [a, b] } = await deliveredLocked(2);
    await db.order.updateMany({ where: { id: { in: [a!, b!] } }, data: { createdAt: new Date(Date.now() - 60 * 86_400_000) } });
    await err(St.toggleOrderStatus(await actor(['ADMIN']), a!, { target: 'CANCELLED', note: 'Хэтэрхий хожуу буцаалт' }), 409, 'too_old');
    await St.toggleOrderStatus(acc, a!, { target: 'CANCELLED', note: '2 сарын дараа буцаасан' });
    await St.toggleOrderStatus(sa, b!, { target: 'CANCELLED', note: '2 сарын дараа буцаасан' });
    expect((await db.order.findMany({ where: { id: { in: [a!, b!] } } })).map((o) => o.status)).toEqual(['CANCELLED', 'CANCELLED']);
    // захиалгын хуудасны СА цуцлалт өөрийн хязгаартай хэвээр
    const c = (await O.createOrder(op, ub({ deliveryDate: today }))).order;
    await db.order.update({ where: { id: c.id }, data: { createdAt: new Date(Date.now() - 15 * 86_400_000) } });
    await recOk();
  });

  it('операторын цалин: цоожилсон цалинд тоологдсон бол дараагийн цалингаас хасна; цоожлоогүй бол автоматаар тоологдохгүй (давхар хасахгүй)', async () => {
    const St = await S(); const Sal = await SAL();
    const key = `u:${op.id}`;
    await Sal.setConfig(sa, { staffKey: key, salaryType: 'ORDER_BASED', baseSalary: 0, bonusSalary: 0, oppRatePerOrder: 1500, dailyRate: 0 });
    const { ids: [a, b, c] } = await deliveredLocked(3);
    const ym = today.slice(0, 7);
    const rec = await Sal.saveSalary(sa, { staffKey: key, ym, half: half() });
    expect(rec.orderCount).toBe(3);
    await Sal.lockSalary(sa, rec.id);
    await St.toggleOrderStatus(acc, a!, { target: 'CANCELLED', note: 'Үйлчлүүлэгч буцаасан 1' });
    await St.toggleOrderStatus(acc, b!, { target: 'CANCELLED', note: 'Үйлчлүүлэгч буцаасан 2' });
    // цоожтой цалин хөдлөхгүй; дараагийн хагас сард 2 × 1,500 = 3,000₮ суутгал
    expect((await db.staffSalaryRecord.findUniqueOrThrow({ where: { id: rec.id } })).orderCount).toBe(3);
    const np = nextPeriod();
    const pre = await Sal.prepareSalary(sa, key, np.ym, np.half);
    expect([pre.auto.lateReturns.length, pre.auto.lateDeduction]).toEqual([2, 3000]);
    expect(pre.auto.lateLabel).toContain('Хүргэсний дараа буцаасан 2 захиалга');
    // дараагийн хагас сард хүргэлт байхгүй тул шилжүүлэх нь сөрөг — ойлгомжтой мессеж (илүүг ажилтны өр болгоно)
    await err(Sal.saveSalary(sa, { staffKey: key, ym: np.ym, half: np.half }), 400, 'negative');
    void c;
  });

  it('цоожлоогүй үед буцаасан бол тэр цалинд л тоологдохгүй, дараагийнхаас хасахгүй', async () => {
    const St = await S(); const Sal = await SAL();
    const key = `u:${op.id}`;
    await Sal.setConfig(sa, { staffKey: key, salaryType: 'ORDER_BASED', baseSalary: 0, bonusSalary: 0, oppRatePerOrder: 1500, dailyRate: 0 });
    const { ids: [a] } = await deliveredLocked(2);
    await St.toggleOrderStatus(acc, a!, { target: 'CANCELLED', note: 'Үйлчлүүлэгч буцаасан' });
    expect((await Sal.prepareSalary(sa, key, today.slice(0, 7), half())).auto.orderCount).toBe(1);
    const np = nextPeriod();
    expect((await Sal.prepareSalary(sa, key, np.ym, np.half)).auto.lateReturns).toHaveLength(0);
  });

  it('Супер админ: нүүрэнд хожуу буцаалтын жагсаалт; 7+ хоног буцаагаагүй бараа — сануулга', async () => {
    const St = await S();
    const DSH = await import('@/lib/services/dashboard'); const DB = await import('@/lib/services/accounting/debts');
    const { ids: [a] } = await deliveredLocked(1);
    await St.toggleOrderStatus(acc, a!, { target: 'CANCELLED', note: 'Үйлчлүүлэгч буцаасан' });
    const l = await DSH.lateReturnList(sa, 1);
    expect(l.items.map((x) => x.id)).toEqual([a]);
    await err(DSH.lateReturnList(acc, 1), 403);
    expect((await DSH.attention(sa)).items.some((x) => x.key === 'late-returns')).toBe(true);
    expect(await DB.staleGoodsAlert(['SUPER_ADMIN'])).toBeNull();
    await db.companyDebt.create({ data: { driverId: drv.id, driverName: drv.name, kind: 'GOODS_NOT_RETURNED', description: 'Буцаагаагүй', amount: 20000, qty: 2, unitPrice: 10000, variantId: v1, date: U.dateOnly(U.ubDay(new Date(), -8)), createdByName: 'Автомат' } });
    expect(await DB.staleGoodsAlert(['SUPER_ADMIN'])).toMatchObject({ drivers: 1, qty: 2, amount: 20000, days: 7 });
    expect(await DB.staleGoodsAlert(['ADMIN'])).toBeNull();
  });
});

describe('#212 хожуу хүргэлт, дугаараар хайх', () => {
  /** a = хүргэсэн, b = жолооч цуцалсан (бараа агуулахад буцаасан) → тооцоо баталгаажсан */
  async function cancelledLocked() {
    const St = await S();
    const [a, b] = await outFor(drv, 2);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await DR.driverCancel(drv, b!, { note: 'Үйлчлүүлэгч утсаа авахгүй байна' });
    const g = await G.goodsView(drv.id);
    await G.receiveReturn(wh, { driverId: drv.id, lines: g.items.filter((i) => i.returnable > 0).map((i) => ({ variantId: i.variantId, qty: i.returnable })), idemKey: key() });
    const day = (await (await C()).computeDay(db, today)).find((x) => x.driverId === drv.id)!;
    await St.submitSettlement(drv, { date: today, cash: day.toReceive });
    const s = await db.driverSettlement.findFirstOrThrow({ where: { driverId: drv.id } });
    await St.approveSettlement(acc, s.id);
    return { a: a!, b: b!, day };
  }

  it('түгжсэн өдрийн цуцлагдсаныг «Хүргэсэн»: бараа үндсэн агуулахаас гарна, тооцоо хөдлөхгүй, дахин солихгүй', async () => {
    const St = await S();
    const { b, day } = await cancelledLocked();
    const ml = await locOf(mainWh); const w1 = await bal(ml, v1); const w2 = await bal(ml, v2);
    const dl = await drvLoc(drv); const d1 = await bal(dl, v1);
    await St.toggleOrderStatus(acc, b, { target: 'DELIVERED', note: 'Үйлчлүүлэгч дараа нь ирж авсан' });
    const o = await db.order.findUniqueOrThrow({ where: { id: b } });
    expect([o.status, !!o.lateDeliveredAt, o.lateDeliverByName, o.collectAmount, o.cancelReason]).toEqual(['DELIVERED', true, acc.name, 0, 'DRIVER_CANCELLED']);
    expect([await bal(ml, v1), await bal(ml, v2), await bal(dl, v1)]).toEqual([w1 - 2, w2 - 1, d1]);
    const day2 = (await (await C()).computeDay(db, today)).find((x) => x.driverId === drv.id)!;
    expect([day2.delivered, day2.cash, day2.salary, day2.toReceive]).toEqual([day.delivered, day.cash, day.salary, day.toReceive]);
    await err(St.toggleOrderStatus(acc, b, { target: 'CANCELLED', note: 'Дахин буцаах' }), 409, 'late_delivered');
    expect(await db.auditLog.count({ where: { action: 'order.late_delivered', entityId: String(b) } })).toBe(1);
    await recOk();
  });

  it('агуулахад бараа хүрэлцэхгүй бол хожуу хүргэлт хийгдэхгүй (үлдэгдэл хасах руу орохгүй)', async () => {
    const St = await S();
    const { b } = await cancelledLocked();
    const ml = await locOf(mainWh);
    const q = await bal(ml, v2);
    await D.createIssue(wh, { warehouseId: mainWh, reason: 'DAMAGE', lines: [{ variantId: v2, qty: q }], note: 'Гэмтэл туршилт', idemKey: key() });
    await err(St.toggleOrderStatus(acc, b, { target: 'DELIVERED', note: 'Үйлчлүүлэгч авсан' }), 409, 'insufficient_stock');
    expect((await db.order.findUniqueOrThrow({ where: { id: b } })).status).toBe('CANCELLED');
    await recOk();
  });

  it('операторын цалин: цоожилсон бол дараагийн цалинд нэмнэ; цоожлоогүй бол ердийнхөөрөө тоологдоно', async () => {
    const St = await S(); const Sal = await SAL();
    const key2 = `u:${op.id}`;
    await Sal.setConfig(sa, { staffKey: key2, salaryType: 'ORDER_BASED', baseSalary: 0, bonusSalary: 0, oppRatePerOrder: 1500, dailyRate: 0 });
    const { b } = await cancelledLocked();
    const ym = today.slice(0, 7);
    const rec = await Sal.saveSalary(sa, { staffKey: key2, ym, half: half() });
    expect(rec.orderCount).toBe(1);
    await Sal.lockSalary(sa, rec.id);
    await St.toggleOrderStatus(acc, b, { target: 'DELIVERED', note: 'Үйлчлүүлэгч дараа нь авсан' });
    const np = nextPeriod();
    const pre = await Sal.prepareSalary(sa, key2, np.ym, np.half);
    expect([pre.auto.lateDelivers.length, pre.auto.lateAddition]).toEqual([1, 1500]);
    expect(pre.auto.lateAddLabel).toContain('Хожуу хүргэсэн 1 захиалга');
    const r2 = await Sal.saveSalary(sa, { staffKey: key2, ym: np.ym, half: np.half });
    expect((r2.additions as { label: string; amount: number }[]).find((x) => x.label.startsWith('Хожуу хүргэсэн'))?.amount).toBe(1500);
  });

  it('цоожлоогүй үед хожуу хүргэсэн бол тэр цалинд тоологдоно, дараагийнд нэмэгдэхгүй', async () => {
    const St = await S(); const Sal = await SAL();
    const key2 = `u:${op.id}`;
    await Sal.setConfig(sa, { staffKey: key2, salaryType: 'ORDER_BASED', baseSalary: 0, bonusSalary: 0, oppRatePerOrder: 1500, dailyRate: 0 });
    const { b } = await cancelledLocked();
    await St.toggleOrderStatus(acc, b, { target: 'DELIVERED', note: 'Үйлчлүүлэгч авсан' });
    expect((await Sal.prepareSalary(sa, key2, today.slice(0, 7), half())).auto.orderCount).toBe(2);
    const np = nextPeriod();
    expect((await Sal.prepareSalary(sa, key2, np.ym, np.half)).auto.lateDelivers).toHaveLength(0);
  });

  it('дугаараар хайх: падааны өдөр, түгжээ, «Төлөв солих» боломж; нягтлан биш бол 403', async () => {
    const St = await S();
    const { a, b } = await cancelledLocked();
    const na = (await db.order.findUniqueOrThrow({ where: { id: a } })).number;
    const f = await St.findOrderForAccounting(acc, na);
    expect([f.order.id, f.locked, f.canToggle, f.handover?.date, f.handover?.driverId]).toEqual([a, true, true, today, drv.id]);
    expect((await St.findOrderForAccounting(acc, String(Number(na)))).order.id).toBe(a); // эхний 0-гүй бичсэн ч олно
    await err(St.findOrderForAccounting(op, na), 403);
    await err(St.findOrderForAccounting(acc, '99999999'), 404);
    await St.toggleOrderStatus(acc, a, { target: 'CANCELLED', note: 'Хожуу буцаасан' });
    const f2 = await St.findOrderForAccounting(acc, na);
    expect([f2.order.late, f2.canToggle]).toEqual(['RETURNED', false]);
    // түгжсэн өдрийн жолоочийн дэлгэрэнгүйд «хожуу» тэмдэг
    const det = await St.accountingDriver(acc, drv.id, today);
    expect(det.orders.find((o) => o.id === a)?.late).toBe('RETURNED');
    expect(det.orders.find((o) => o.id === b)?.late).toBeNull();
    await recOk();
  });
});
