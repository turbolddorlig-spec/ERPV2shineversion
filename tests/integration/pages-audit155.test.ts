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


describe('#155 бараа', () => {
  it('үлдэгдэлтэй / нээлттэй захиалгатай хувилбарын «идэвхтэй»-г авахгүй; хоосон бол болно; үсгийн хэлбэр засахад хувилбар дагана; хасагдсан нэр рүү солих — ойлгомжтой мессеж', async () => {
    let p = await P.getProduct(sa, (await db.productVariant.findUniqueOrThrow({ where: { id: v1 } })).productId);
    await err(P.updateProduct(sa, p.id, { variants: [{ id: v1, isActive: false }] }, { reason: 'Унтраах гэж оролдов', version: p.version }), 409, 'variant_has_stock');
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: v1 } })).isActive).toBe(true);
    // Үлдэгдэлгүй хувилбар
    const q = await P.createProduct(sa, { code: 'Q1', name: 'Цамц', price: 20000, colors: ['улаан', 'Цэнхэр'] });
    const [r1] = q.variants.map((v) => v.id) as [number, number];
    p = await P.getProduct(sa, q.id);
    await P.updateProduct(sa, q.id, { colors: ['Улаан', 'Цэнхэр'] }, { reason: 'Үсэг засав', version: p.version });
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: r1 } })).color).toBe('Улаан');
    p = await P.getProduct(sa, q.id);
    await P.updateProduct(sa, q.id, { colors: ['Улаан'] }, { reason: 'Цэнхэр хасав', version: p.version });
    await D.createReceipt(wh, { warehouseId: mainWh, lines: [{ variantId: r1, qty: 3 }], idemKey: key() });
    p = await P.getProduct(sa, q.id);
    const e = await err(P.updateProduct(sa, q.id, { colors: ['Цэнхэр'], renames: [{ axis: 'color', from: 'Улаан', to: 'Цэнхэр' }] }, { reason: 'Нэр солив', version: p.version }), 409, 'rename_clash');
    expect(e.message).toContain('Цэнхэр');
    await recOk();
  });
});

describe('#155 жолоочийн хяналт, асуудал', () => {
  it('идэвхгүй болсон жолоочийн бараа / мөнгө хяналтад харагдсаар; «Маргааш» тооцоотой ижил', async () => {
    const [a, b] = await outFor(drv, 2);
    await DR.deliverOrder(drv, a, { payment: 'CASH' });
    await DR.postponeOrder(drv, b, {});
    await db.user.update({ where: { id: drv.id }, data: { isActive: false } });
    const row = (await G.driverControl(sa)).items.find((x) => x.id === drv.id)!;
    expect(row).toBeTruthy();
    expect(row.name).toContain('идэвхгүй');
    expect([row.delivered, row.postponed, row.cash > 0, row.goods > 0]).toEqual([1, 1, true, true]);
    await recOk();
  });

  it('2 ахлах зэрэг өөр шийдвэр — хоёрдахь нь «амжилттай» биш 409; ижил шийдвэр давтвал давхардалгүй', async () => {
    const l1 = await actor(['OPERATOR_LEAD']); const l2 = await actor(['OPERATOR_LEAD']);
    const [a] = await outFor(drv, 1);
    await DR.reportIssue(drv, a, { type: 'WRONG_NUMBER', note: 'Утас холбогдохгүй' });
    const rs = await Promise.allSettled([DR.resolveIssue(l1, a, { action: 'fix', note: 'Зөв утас 99112233' }), DR.resolveIssue(l2, a, { action: 'cancel', note: 'Захиалагч татгалзсан', fault: 'OPERATOR' })]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rej = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rej.reason as AppError).code).toBe('already_resolved');
    const st = (await db.order.findUniqueOrThrow({ where: { id: a } })).issueStatus;
    const again = await DR.resolveIssue(l1, a, st === 'FIXED' ? { action: 'fix', note: 'Давтан дарсан' } : { action: 'cancel', note: 'Давтан дарсан', fault: 'OPERATOR' });
    expect((again as { duplicate?: boolean }).duplicate).toBe(true);
    await recOk();
  });
});

describe('#155 төлсөн ч цуцлагдсан, СА цуцлах', () => {
  it('жолооч цуцлахад мөнгө наалдсан чигтээ; СА-д сануулга + жагсаалт; «Шийдсэн» → алга; бусдад харагдахгүй', async () => {
    const B = await import('@/lib/services/accounting/bank');
    const pre = (await O.createOrder(op, ub({ deliveryDate: today, prepaidWait: true }))).order.id;
    await bankPay(pre);
    await L.assignOrders(lead, { ids: [pre], driverId: drv.id });
    await handTo(drv, today, [pre]);
    await DR.driverCancel(drv, pre, { note: 'Захиалагч авахаас татгалзсан' });
    const tx = await db.bankTransaction.findFirstOrThrow({ where: { orderId: pre } });
    expect(tx.status).not.toBe('UNMATCHED');
    expect(await B.paidCancelledAlert(['SUPER_ADMIN'])).toEqual({ count: 1 });
    expect(await B.paidCancelledAlert(['ADMIN'])).toBeNull();
    await err(B.paidCancelledList(acc), 403);
    const l = await B.paidCancelledList(sa);
    expect(l.items.map((x) => [x.id, x.paid > 0])).toEqual([[pre, true]]);
    await err(B.markPaidCancelReviewed(sa, pre, ''), 400);
    await B.markPaidCancelReviewed(sa, pre, 'Мөнгийг буцаасан');
    expect(await B.paidCancelledAlert(['SUPER_ADMIN'])).toBeNull();
    await recOk();
  });

  it('СА нэг товчоор: шинэ — нөөц суллагдана; хүргэсэн — бараа жолоочид буцна (журналаар), тулгалт 0; бусад хүн хүргэснийг цуцлахгүй', async () => {
    const n = (await O.createOrder(op, ub({ deliveryDate: today }))).order;
    await O.saCancelOrder(sa, n.id, { reason: 'OTHER', note: 'Супер админ туршилт', version: n.version });
    expect((await db.order.findUniqueOrThrow({ where: { id: n.id } })).status).toBe('CANCELLED');
    expect(await db.stockReservation.count({ where: { orderId: n.id } })).toBe(0);
    const [a] = await outFor(drv, 1);
    await DR.deliverOrder(drv, a, { payment: 'CASH' });
    const dl = await drvLoc(drv);
    const before = await bal(dl, v1);
    const o = await db.order.findUniqueOrThrow({ where: { id: a } });
    await err(O.saCancelOrder(acc, a, { note: 'Нягтлан оролдов', version: o.version }), 403);
    await O.saCancelOrder(sa, a, { reason: 'OTHER', note: 'Үйлчлүүлэгч буцаасан', version: o.version });
    expect((await db.order.findUniqueOrThrow({ where: { id: a } })).status).toBe('CANCELLED');
    expect(await bal(dl, v1)).toBe(before + 2);
    await recOk();
  });
});

describe('#155 тохиргоо, хэрэглэгч, нэвтрэх', () => {
  it('торгуулийн тохиргоо зэрэг хадгалахад алдагдахгүй', async () => {
    const PN = await import('@/lib/services/penalties');
    const pen = await actor(['PENALTY_OFFICER']);
    await Promise.all([
      PN.saveCategory(sa, { type: 'OPP_ERROR', name: 'Хаяг буруу бичсэн', defaultAmount: 5000 }),
      PN.saveCategory(pen, { type: 'OPP_ERROR', name: 'Утас буруу бичсэн', defaultAmount: 3000 }),
      PN.setAutoAmounts(sa, { OPP_ERROR: 7000 }),
    ]);
    const c = await PN.readPenaltyConfig();
    expect(c.categories.map((x) => x.name).sort()).toEqual(expect.arrayContaining(['Хаяг буруу бичсэн', 'Утас буруу бичсэн']));
    expect(c.autoAmount.OPP_ERROR).toBe(7000);
  });

  it('админ бусад админыг удирдахгүй; супер админы цоожийг тайлна', async () => {
    const US = await import('@/lib/services/users');
    const adm = await actor(['ADMIN']); const adm2 = await actor(['ADMIN']);
    await err(US.deactivateUser(adm, adm2.id), 403);
    await err(US.createUser(adm, { phone: '99887766', name: 'Шинэ админ', roles: ['ADMIN'] }), 403);
    await db.user.update({ where: { id: sa.id }, data: { lockedUntil: new Date(Date.now() + 600_000) } });
    await US.unlockUser(adm, sa.id);
    expect((await db.user.findUniqueOrThrow({ where: { id: sa.id } })).lockedUntil).toBeNull();
  });

  it('Meta токен шифрлэгдэж хадгалагдана, хариунд зөвхөн сүүлийн 4 тэмдэгт', async () => {
    const M = await import('@/lib/services/orders/meta');
    const t = 'EAAB' + 'x'.repeat(40) + 'WXYZ';
    const r = await M.setMetaSettings(sa, { pixelId: '1234567890', token: t });
    expect(r.tokenHint).toBe('…WXYZ');
    const raw = await db.appSetting.findUniqueOrThrow({ where: { key: 'metaAccessToken' } });
    expect(String(raw.value)).not.toContain(t);
    expect(String(raw.value).startsWith('v1:')).toBe(true);
  });
});
