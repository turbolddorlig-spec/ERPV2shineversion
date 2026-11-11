import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** Бүрэн тестээр илэрсэн алдааны засвар (#124) — эзний шийдвэр бүрээр */
let db: typeof import('@/lib/db').db;
let P: typeof import('@/lib/services/products');
let W: typeof import('@/lib/services/stock/warehouses');
let D: typeof import('@/lib/services/stock/docs');
let O: typeof import('@/lib/services/orders/orders');
let Q: typeof import('@/lib/services/orders/queries');
let A: typeof import('@/lib/services/orders/admin');
let M: typeof import('@/lib/services/orders/meta');
let B: typeof import('@/lib/services/accounting/bank');
let U: typeof import('@/lib/ubdate');
beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  P = await import('@/lib/services/products'); W = await import('@/lib/services/stock/warehouses'); D = await import('@/lib/services/stock/docs');
  O = await import('@/lib/services/orders/orders'); Q = await import('@/lib/services/orders/queries'); A = await import('@/lib/services/orders/admin');
  M = await import('@/lib/services/orders/meta'); B = await import('@/lib/services/accounting/bank'); U = await import('@/lib/ubdate');
});
let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(76000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
async function err(p: Promise<unknown>, status: number, code?: string) {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AppError); expect((e as AppError).status).toBe(status); if (code) expect((e as AppError).code).toBe(code); return; }
  throw new Error(`Алдаа гарах ёстой байсан (${status})`);
}
let sa: UserActor; let op: UserActor; let lead: UserActor; let acc: UserActor; let page1: number; let v1: number; let vFee: number;
const ub = (over: Record<string, unknown> = {}) => ({ phone: '99112233', province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Нарны 45-р байр', pageId: page1, lines: [{ variantId: v1, qty: 2 }], idemKey: randomUUID(), ...over });
const ver = async (id: number) => (await db.order.findUniqueOrThrow({ where: { id } })).version;

beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); op = await actor(['OPERATOR']); lead = await actor(['OPERATOR_LEAD']); acc = await actor(['ACCOUNTING']);
  page1 = (await A.savePage(sa, { name: 'Гутал Шоп' })).id;
  v1 = (await P.createProduct(sa, { code: 'G1', name: 'Гутлын үдээс', price: 15000 })).variants[0]!.id;
  vFee = (await P.createProduct(sa, { code: 'F1', name: 'Хүргэлттэй бараа', price: 20000, deliveryIncluded: false })).variants[0]!.id;
  const wh = (await W.createWarehouse(sa, { name: 'Төв' })).id;
  await D.createReceipt(sa, { warehouseId: wh, lines: [{ variantId: v1, qty: 50 }, { variantId: vFee, qty: 50 }], idemKey: randomUUID() });
});

describe('#124-1 урьдчилж төлсөн захиалгыг засах', () => {
  it('гараар «Мөнгө орсон»: дүн өсвөл Төлбөр хүлээж буй (дутуу), дахин төлөхөд Шинэ; буурвал илүү төлөлт', async () => {
    const { order } = await O.createOrder(op, ub({ prepaidWait: true }));
    expect([order.status, order.total]).toEqual(['PENDING_PAYMENT', 30000]);
    await O.markPaid(lead, order.id);
    let o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect([o.status, o.prepaid, o.paidAmount]).toEqual(['NEW', true, 30000]);
    // бараа нэмж 45,000₮ → дутуу 15,000₮ → Төлбөр хүлээж буй
    await O.updateOrder(op, order.id, { lines: [{ variantId: v1, qty: 3 }], version: o.version });
    o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect([o.status, o.prepaid, o.total, o.confirmedAt]).toEqual(['PENDING_PAYMENT', false, 45000, null]);
    const log = await db.auditLog.findFirstOrThrow({ where: { entityId: String(order.id), action: 'order.updated' }, orderBy: { id: 'desc' } });
    expect(JSON.stringify(log.details)).toContain('дутуу 15,000₮');
    // дахин төлөгдөхөд Шинэ, дугаар хэвээр
    await O.markPaid(lead, order.id);
    o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect([o.status, o.prepaid, o.paidAmount, o.number]).toEqual(['NEW', true, 45000, order.number]);
    // бараа хасаж 15,000₮ → илүү төлөлт 30,000₮, захиалга хэвээр явна
    await O.updateOrder(op, order.id, { lines: [{ variantId: v1, qty: 1 }], version: o.version });
    o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect([o.status, o.prepaid]).toEqual(['NEW', true]);
    const list = await Q.listOrders(sa, { overpaid: true, statuses: 'NEW' });
    expect(list.items.map((x) => [x.id, x.overpaid])).toEqual([[order.id, 30000]]);
  });

  it('банкаар төлсөн: дүн өсвөл Хэсэгчлэн, дутуу орж ирэхэд автоматаар Шинэ; буурвал гүйлгээ «Илүү»', async () => {
    const { order } = await O.createOrder(op, ub({ province: 'Дархан-Уул', district: 'Дархан', khoroo: null }));
    expect(order.status).toBe('PENDING_PAYMENT');
    const t0 = order.total;
    await B.importTransactions(acc, [{ date: new Date(), description: `99112233 гутал`, amount: t0 }], 'CSV');
    let o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect([o.status, o.paidAmount]).toEqual(['NEW', t0]);
    await O.updateOrder(op, order.id, { lines: [{ variantId: v1, qty: 3 }], version: o.version });
    o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.status).toBe('PENDING_PAYMENT');
    expect((await db.bankTransaction.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe('PARTIAL_PAYMENT');
    await B.importTransactions(acc, [{ date: new Date(), description: `99112233 нэмэлт`, amount: 15000 }], 'CSV');
    o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect([o.status, o.paidAmount]).toEqual(['NEW', t0 + 15000]);
    await O.updateOrder(op, order.id, { lines: [{ variantId: v1, qty: 1 }], version: o.version });
    expect((await db.bankTransaction.findMany({ where: { orderId: order.id } })).every((t) => t.status === 'EXCESS_AMOUNT')).toBe(true);
  });
});

describe('#124-3 хүргэлтийн төлбөр үүссэн үеийнхээрээ', () => {
  it('тохиргоо өөрчлөгдсөн ч хаяг засахад хуучин төлбөр; бүс солигдвол шинэ бүсийн төлбөр', async () => {
    await A.setOrderSettings(sa, { feeUB: 5000, feeRural: 8000 });
    const { order } = await O.createOrder(op, ub({ lines: [{ variantId: vFee, qty: 1 }] }));
    expect([order.deliveryFee, order.total]).toEqual([5000, 25000]);
    await A.setOrderSettings(sa, { feeUB: 6000 });
    let o = await O.updateOrder(op, order.id, { addressDetail: 'Шинэ хаяг 7-р байр', version: await ver(order.id) });
    expect([o.order.deliveryFee, o.order.total]).toEqual([5000, 25000]);
    o = await O.updateOrder(op, order.id, { province: 'Дархан-Уул', district: 'Дархан', khoroo: null, version: await ver(order.id) });
    expect(o.order.deliveryFee).toBe(8000);
  });
});

describe('#124-4 хүргэх өдөр өнгөрсөн захиалга', () => {
  it('засахгүй — цуцлаад шинээр үүсгэ гэж ойлгомжтой; цуцалж болно', async () => {
    const { order } = await O.createOrder(op, ub());
    await db.order.update({ where: { id: order.id }, data: { deliveryDate: U.dateOnly(U.ubDay(new Date(), -1)) } });
    await err(O.updateOrder(op, order.id, { note: 'x', version: await ver(order.id) }), 409, 'past_delivery');
    await O.cancelOrder(op, order.id, { reason: 'CUSTOMER_CANCELLED', note: 'Шинээр үүсгэнэ', version: await ver(order.id) });
  });
});

describe('#124-5 Meta: буцаагаад дахин төлөгдвөл илгээнэ (нэг л удаа)', () => {
  it('SKIPPED → PENDING; илгээгдсэнийг дахин илгээхгүй', async () => {
    await M.setMetaSettings(sa, { pixelId: '1234567890', token: 'EAAB' + 'x'.repeat(40) });
    const { order } = await O.createOrder(op, ub({ prepaidWait: true }));
    await O.markPaid(lead, order.id);
    await O.undoPaid(lead, order.id, { note: 'Андуурсан төлбөр' });
    expect((await db.metaEvent.findUniqueOrThrow({ where: { orderId: order.id } })).status).toBe('SKIPPED');
    await O.markPaid(lead, order.id);
    expect((await db.metaEvent.findUniqueOrThrow({ where: { orderId: order.id } })).status).toBe('PENDING');
    await db.metaEvent.update({ where: { orderId: order.id }, data: { status: 'SENT' } });
    await O.undoPaid(lead, order.id, { note: 'Дахин андуурсан' });
    await O.markPaid(lead, order.id);
    expect((await db.metaEvent.findUniqueOrThrow({ where: { orderId: order.id } })).status).toBe('SENT');
  });
});

describe('#124-4 хуваарилагдаагүй «Шинэ» захиалгын сануулга', () => {
  it('хоносон бол үргэлж 🔴; тохиргооны цагаас хойш өнөөдрийнх 🔴; эрхээр', async () => {
    const AS = await import('@/lib/services/delivery/assign');
    await A.setOrderSettings(sa, { assignHour: 21 });
    const { order } = await O.createOrder(op, ub());
    AS.bustUnassignedAlert();
    const hourNow = new Date(Date.now() + 8 * 3_600_000).getUTCHours();
    const a1 = await AS.unassignedAlert(['DRIVER_LEAD']);
    expect(a1).toEqual(hourNow >= 21 ? { today: 1, leftover: 0, late: true, hour: 21 } : null);
    expect(await AS.unassignedAlert(['OPERATOR'])).toBeNull();
    // хоносон: хүргэх өдөр нь өнөөдөр, хуваарилагдаагүй
    await db.order.update({ where: { id: order.id }, data: { deliveryDate: U.dateOnly(U.ubDay()) } });
    AS.bustUnassignedAlert();
    expect((await AS.unassignedAlert(['ADMIN']))?.leftover).toBe(1);
    await err(A.setOrderSettings(sa, { assignHour: 5 }), 400);
  });
});

describe('#124-И банкаар таарсан төлбөрийн «Буцаах»', () => {
  it('«Мөнгө орсон»-ыг буцаахгүй — банкны хуудсанд зөв захиалгад тааруулахад хуучин нь «Төлбөр хүлээж буй»', async () => {
    const { order: a } = await O.createOrder(op, ub({ prepaidWait: true }));
    const { order: b } = await O.createOrder(op, ub({ phone: '99445566', prepaidWait: true }));
    await B.importTransactions(acc, [{ date: new Date(), description: '99112233 гутал', amount: a.total }], 'CSV');
    expect((await db.order.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('NEW');
    await err(O.undoPaid(lead, a.id, { note: 'Андуурч таарсан' }), 409, 'bank_linked');
    const t = await db.bankTransaction.findFirstOrThrow({ where: { orderId: a.id } });
    await B.manualMatch(acc, t.id, { orderNumber: b.number });
    const [oa, ob] = await Promise.all([db.order.findUniqueOrThrow({ where: { id: a.id } }), db.order.findUniqueOrThrow({ where: { id: b.id } })]);
    expect([oa.status, oa.prepaid, ob.status, ob.prepaid]).toEqual(['PENDING_PAYMENT', false, 'NEW', true]);
  });
});
