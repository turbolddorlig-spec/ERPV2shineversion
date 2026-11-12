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
    expect([o.status, o.prepaid, o.total, o.confirmedAt !== null]).toEqual(['PENDING_PAYMENT', false, 45000, true]); // Б22: анхны өдөр хэвээр
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

describe('аудит Б7: илүү төлөлт бүх тохиолдолд «Банк импорт → Илүү»-д, буцаахад тэмдэг арилна', () => {
  it('гараар «Мөнгө орсон» → дүн буурсан: банкгүй илүү жагсаалтад; «Илүүг буцаасан» → тэмдэг арилна', async () => {
    const { order } = await O.createOrder(op, ub({ prepaidWait: true }));
    await O.markPaid(lead, order.id);
    const o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    await O.updateOrder(op, order.id, { lines: [{ variantId: v1, qty: 1 }], version: o.version });
    const l = await B.listTransactions(acc, { tab: 'EXCESS_AMOUNT' });
    expect(l.manualExcess.map((x) => [x.number, x.excess])).toEqual([[order.number, 15000]]);
    expect(l.manualExcess[0]!.why).toContain('буцаана');
    await err(B.refundManualExcess(op, order.id), 403);
    expect((await B.refundManualExcess(acc, order.id)).refunded).toBe(15000);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paidAmount).toBe(15000);
    expect((await Q.listOrders(sa, { overpaid: true })).items).toHaveLength(0);
    expect((await B.listTransactions(acc, { tab: 'EXCESS_AMOUNT' })).manualExcess).toHaveLength(0);
    await err(B.refundManualExcess(acc, order.id), 409, 'not_excess');
  });
  it('илүү 2 гүйлгээнд хуваагдсан ч буцаана (өмнө нь «excess_split»)', async () => {
    const { order } = await O.createOrder(op, ub({ province: 'Дархан-Уул', district: 'Дархан', khoroo: null, lines: [{ variantId: v1, qty: 4 }] }));
    await B.importTransactions(acc, [{ date: new Date(), description: '99112233 1', amount: 40000 }], 'CSV');
    await B.importTransactions(acc, [{ date: new Date(), description: '99112233 2', amount: order.total - 40000 }], 'CSV');
    let o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.status).toBe('NEW');
    await O.updateOrder(op, order.id, { lines: [{ variantId: v1, qty: 1 }], version: o.version });
    o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    const excess = order.total - o.total;
    expect(excess).toBeGreaterThan(order.total - 40000);
    const t = (await db.bankTransaction.findMany({ where: { orderId: order.id }, orderBy: { id: 'desc' } }))[0]!;
    expect((await B.refundExcess(acc, t.id)).refunded).toBe(excess);
    const txs = await db.bankTransaction.findMany({ where: { orderId: order.id } });
    expect(txs.reduce((s2, x) => s2 + x.excessRefunded, 0)).toBe(excess);
    expect(txs.every((x) => x.status === 'MATCHED')).toBe(true);
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
    // А11: өнөөдөр үүсээд өнөөдөр хүргэх → хоносон биш (өнөөдрийн ажил)
    await db.order.update({ where: { id: order.id }, data: { deliveryDate: U.dateOnly(U.ubDay()) } });
    AS.bustUnassignedAlert();
    expect((await AS.unassignedAlert(['ADMIN']))?.leftover ?? 0).toBe(0);
    // хоносон: өчигдөр үүссэн, хүргэх өдөр нь өнөөдөр, хуваарилагдаагүй
    await db.order.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - 86_400_000 * 1.5) } });
    AS.bustUnassignedAlert();
    expect((await AS.unassignedAlert(['ADMIN']))?.leftover).toBe(1);
    await err(A.setOrderSettings(sa, { assignHour: 5 }), 400);
  });
});

describe('#124-И банкаар таарсан төлбөрийн «Буцаах»', () => {
  it('банкаар таарсан «Мөнгө орсон»-ыг буцаахгүй; таарсан гүйлгээг шилжүүлэхгүй', async () => {
    const { order: a } = await O.createOrder(op, ub({ prepaidWait: true }));
    const { order: b } = await O.createOrder(op, ub({ phone: '99445566', prepaidWait: true }));
    await B.importTransactions(acc, [{ date: new Date(), description: '99112233 гутал', amount: a.total }], 'CSV');
    expect((await db.order.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('NEW');
    await err(O.undoPaid(lead, a.id, { note: 'Андуурч таарсан' }), 409, 'bank_linked');
    // #127: таарсан бол таарсан — өөр захиалгад шилжүүлэхгүй
    const t = await db.bankTransaction.findFirstOrThrow({ where: { orderId: a.id } });
    await err(B.manualMatch(acc, t.id, { orderNumber: b.number }), 409, 'already_matched');
    expect((await db.order.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('PENDING_PAYMENT');
  });
});

describe('орон нутгийн хаяг (#125)', () => {
  it('байр заавал биш — бичихгүй бол зөвхөн аймгийн нэр; бичвэл тэр нь; УБ-д заавал', async () => {
    const { order: a } = await O.createOrder(op, ub({ province: 'Увс', district: null, khoroo: null, addressDetail: '' }));
    expect([a.addressDetail, (await Q.getOrder(sa, a.id)).fullAddress]).toEqual(['', 'Увс']);
    const { order: b } = await O.createOrder(op, ub({ phone: '99001122', province: 'Дархан-Уул', district: null, khoroo: null, addressDetail: '  ' }));
    expect(b.addressDetail).toBe('');
    const { order: c } = await O.createOrder(op, ub({ phone: '99001133', province: 'Ховд', district: null, khoroo: null, addressDetail: 'Жаргалант сум, 3-р баг' }));
    expect(c.addressDetail).toBe('Жаргалант сум, 3-р баг');
    await err(O.createOrder(op, ub({ phone: '99001144', addressDetail: '' })), 400, 'bad_address');
  });
});

describe('банкны утга дахь зай / зураастай утас (#126)', () => {
  it('«9988-7711», «9988 7711» → 99887711 захиалгатай автоматаар таарна', async () => {
    const { order: a } = await O.createOrder(op, ub({ phone: '99887711', prepaidWait: true }));
    await B.importTransactions(acc, [{ date: new Date(), description: 'Bat 9988-7711', amount: a.total }], 'CSV');
    expect((await db.order.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('NEW');
    const { order: b } = await O.createOrder(op, ub({ phone: '88776655', prepaidWait: true }));
    await B.importTransactions(acc, [{ date: new Date(), description: '8877 6655 guilgee', amount: b.total }], 'CSV');
    expect((await db.order.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('NEW');
  });
});

describe('өмнө танигдаагүй гүйлгээг дахин тааруулах (#126)', () => {
  it('утасгүй «Таараагүй» гүйлгээнээс утсыг олж хүлээгдэж буй захиалгатай тааруулна', async () => {
    const { order: a } = await O.createOrder(op, ub({ phone: '99887711', prepaidWait: true }));
    const t = await db.bankTransaction.create({ data: { txDate: new Date(), description: 'Bat 9988 7711', amount: a.total, phone: null, source: 'CSV', importedByName: 'тест' } });
    const r = await B.rescanUnmatched();
    expect([r.phones, r.matched]).toEqual([1, 1]);
    expect([(await db.order.findUniqueOrThrow({ where: { id: a.id } })).status, (await db.bankTransaction.findUniqueOrThrow({ where: { id: t.id } })).phone]).toEqual(['NEW', '99887711']);
    expect((await B.rescanUnmatched()).phones).toBe(0);
  });
});

describe('банкны «Илүү»-г буцаах (#129)', () => {
  it('илүү дүн = төлсөн − нийт; буцаасны дараа «Таарсан», захиалгын илүү төлөлт арилна; давтахгүй', async () => {
    const { order: a } = await O.createOrder(op, ub({ phone: '99887722', prepaidWait: true }));
    await B.importTransactions(acc, [{ date: new Date(), description: '99887722 tulbur', amount: a.total + 5000 }], 'CSV');
    const t = await db.bankTransaction.findFirstOrThrow({ where: { orderId: a.id } });
    expect(t.status).toBe('EXCESS_AMOUNT');
    expect((await B.listTransactions(acc, { tab: 'EXCESS_AMOUNT' })).items.find((x) => x.id === t.id)?.excess).toBe(5000);
    await err(B.refundExcess(op, t.id), 403);
    expect(await B.refundExcess(acc, t.id)).toEqual({ refunded: 5000, order: a.number });
    const t2 = await db.bankTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect([t2.status, t2.excessRefunded]).toEqual(['MATCHED', 5000]);
    const o = await db.order.findUniqueOrThrow({ where: { id: a.id } });
    expect([o.status, o.paidAmount]).toEqual(['NEW', a.total]);
    expect((await Q.listOrders(sa, { overpaid: true })).items).toHaveLength(0);
    await err(B.refundExcess(acc, t.id), 409, 'not_excess');
    expect(await db.auditLog.count({ where: { action: 'bank.excess_refunded' } })).toBe(1);
  });
});
