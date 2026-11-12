import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';
import { bankPay } from '../helpers/bankPay';

let db: typeof import('@/lib/db').db;
let P: typeof import('@/lib/services/products');
let W: typeof import('@/lib/services/stock/warehouses');
let D: typeof import('@/lib/services/stock/docs');
let O: typeof import('@/lib/services/orders/orders');
let Q: typeof import('@/lib/services/orders/queries');
let A: typeof import('@/lib/services/orders/admin');
let C: typeof import('@/lib/services/orders/calls');
let R: typeof import('@/lib/services/orders/reports');
let M: typeof import('@/lib/services/orders/meta');
let V: typeof import('@/lib/services/stock/views');
let U: typeof import('@/lib/ubdate');

beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  P = await import('@/lib/services/products');
  W = await import('@/lib/services/stock/warehouses');
  D = await import('@/lib/services/stock/docs');
  O = await import('@/lib/services/orders/orders');
  Q = await import('@/lib/services/orders/queries');
  A = await import('@/lib/services/orders/admin');
  C = await import('@/lib/services/orders/calls');
  R = await import('@/lib/services/orders/reports');
  M = await import('@/lib/services/orders/meta');
  V = await import('@/lib/services/stock/views');
  U = await import('@/lib/ubdate');
});

let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(74000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
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

let sa: UserActor; let op: UserActor; let op2: UserActor; let lead: UserActor; let wh: UserActor;
let page1: number; let page2: number; let v1: number; let v2: number; let vFee: number; let mainWh: number;

const ub = (over: Record<string, unknown> = {}) => ({
  phone: '99112233', province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Нарны хороолол 45-р байр, 56 тоот',
  pageId: page1, lines: [{ variantId: v1, qty: 2 }], idemKey: key(), ...over,
});

beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); op = await actor(['OPERATOR']); op2 = await actor(['OPERATOR']); lead = await actor(['OPERATOR_LEAD']); wh = await actor(['WAREHOUSE']);
  page1 = (await A.savePage(sa, { name: 'Гутал Шоп' })).id;
  page2 = (await A.savePage(sa, { name: 'Гоо сайхан МН' })).id;
  const shoe = await P.createProduct(sa, { code: 'G1', name: 'Гутлын үдээс', price: 10000, sizes: ['S', 'L'] });
  [v1, v2] = shoe.variants.map((v) => v.id) as [number, number];
  const sep = await P.createProduct(sa, { code: 'F1', name: 'Хүргэлтгүй үнэтэй бараа', price: 15000, deliveryIncluded: false });
  vFee = sep.variants[0]!.id;
  mainWh = (await W.createWarehouse(sa, { name: 'Төв агуулах' })).id;
  await D.createReceipt(wh, { warehouseId: mainWh, lines: [{ variantId: v1, qty: 10 }, { variantId: v2, qty: 3 }, { variantId: vFee, qty: 5 }], idemKey: key() });
});
afterEach(() => { vi.unstubAllGlobals(); });


/** Аудит #142 — захиалгын хуудасны эрсдэлүүдийн засвар */
describe('#142 захиалга: банкаар л төлсөн, утас шалгах, зээл, хүргэлтийн төлбөр, товлосон давхардал, хайлт', () => {
  it('«Мөнгө орсон» гараар хэн ч болохгүй (Супер админ ч) — зөвхөн банкны гүйлгээгээр', async () => {
    const { order } = await O.createOrder(op, ub({ prepaidWait: true }));
    await err(O.markPaid(sa, order.id), 403, 'bank_only');
    await err(O.markPaid(lead, order.id), 403, 'bank_only');
    const B = await import('@/lib/services/accounting/bank');
    await B.importTransactions({ id: null, name: 'т' }, [{ date: new Date(), description: `${order.phone} төлбөр`, amount: order.total, phone: order.phone }], 'CSV');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } }))).toMatchObject({ status: 'NEW', prepaid: true, paidAmount: order.total });
  });

  it('банкны гүйлгээг гараар тааруулахад утас өөр бол шалтгаан заавал, түүхэнд', async () => {
    const B = await import('@/lib/services/accounting/bank');
    const acc = await actor(['ACCOUNTING']);
    const { order } = await O.createOrder(op, ub({ prepaidWait: true }));
    await B.importTransactions({ id: null, name: 'т' }, [{ date: new Date(), description: '88001122 өөр хүн', amount: order.total, phone: '88001122' }], 'CSV');
    const t = await db.bankTransaction.findFirstOrThrow();
    expect(t.orderId).toBeNull();
    await err(B.manualMatch(acc, t.id, { orderNumber: order.number }), 409, 'phone_mismatch');
    await B.manualMatch(acc, t.id, { orderNumber: order.number, note: 'Ах нь өөрийн данснаас шилжүүлсэн' });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).prepaid).toBe(true);
    const a = await db.auditLog.findFirstOrThrow({ where: { action: 'bank.manual_match' } });
    expect(JSON.stringify(a.details)).toContain('phoneMismatch');
  });

  it('захиалгад түгжигдсэн барааг ажилтанд зээлээр гаргахгүй', async () => {
    const L = await import('@/lib/services/stock/loans');
    await O.createOrder(op, ub({ lines: [{ variantId: v2, qty: 3 }] })); // v2: байгаа 3, бүгд захиалгад
    const staff = await actor(['OPERATOR']);
    const r = await L.requestLoan(staff, { lines: [{ variantId: v2, qty: 1 }], idemKey: key() });
    await err(L.issueLoan(wh, r.loan.id, { warehouseId: mainWh }), 409, 'reserved_stock');
    const r2 = await L.requestLoan(staff, { lines: [{ variantId: v1, qty: 1 }], idemKey: key() });
    await L.issueLoan(wh, r2.loan.id, { warehouseId: mainWh });
    expect((await V.reconcile(sa, { fresh: true })).ok).toBe(true);
  });

  it('тооллогоор дутаад захиалгад түгжигдсэнээс бага үлдвэл анхааруулна (хориглохгүй)', async () => {
    const CT = await import('@/lib/services/stock/counts');
    const adm = await actor(['ADMIN']);
    await O.createOrder(op, ub({ lines: [{ variantId: v2, qty: 3 }] }));
    const c = await CT.startCount(wh, { warehouseId: mainWh, note: 'Сарын тооллого' });
    await CT.setCountLine(wh, c.id, { variantId: v2, countedQty: 1 });
    await CT.submitCount(wh, c.id);
    const r = await CT.decideCount(adm, c.id, { lineIds: 'all', action: 'approve' });
    expect(r.reservedShort).toEqual([{ variantId: v2, total: 1, reserved: 3 }]);
  });

  it('гараар өсгөсөн хүргэлтийн төлбөрийг бууруулахад шалтгаан заавал, хөнгөлөлтийн хяналтад', async () => {
    const { order } = await O.createOrder(op, ub({ lines: [{ variantId: vFee, qty: 1 }], deliveryFee: 20000, feeReason: 'Алслагдсан хороолол' }));
    expect(order.deliveryFeeEdited).toBe(true);
    await err(O.updateOrder(op, order.id, { deliveryFee: '', version: order.version }), 400, 'fee_reason');
    await O.updateOrder(op, order.id, { deliveryFee: '', feeReason: 'Үйлчлүүлэгч гомдоллосон', version: order.version });
    const a = await db.auditLog.findFirstOrThrow({ where: { action: 'order.updated' }, orderBy: { id: 'desc' } });
    expect(a.tags).toContain('discount');
  });

  it('товлосон захиалгыг маргааш руу ойртуулахад тэр утсаар идэвхтэй захиалга байвал болохгүй', async () => {
    const far = U.ubDay(new Date(), 5);
    const s = await O.createOrder(op, ub({ deliveryDate: far }));
    await O.createOrder(op2, ub({ lines: [{ variantId: v1, qty: 1 }] })); // товлосон нь блоклохгүй (Б3)
    await err(O.updateOrder(op, s.order.id, { deliveryDate: U.ubDay(new Date(), 1), version: s.order.version }), 409, 'duplicate_order');
  });

  it('хайлт: 1–3 оронтой тоогоор хайхгүй (хэт өргөн); 4+ оронтой утас олдоно', async () => {
    const { order } = await O.createOrder(op, ub());
    expect(await Q.searchIds('991')).toEqual([]);
    expect(await Q.searchIds('9911')).toContain(order.id);
    expect((await Q.listOrders(sa, { q: '1122' })).items.map((x) => x.id)).toContain(order.id);
  });
});
