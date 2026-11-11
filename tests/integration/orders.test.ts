import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

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

describe('захиалга үүсгэх', () => {
  it('УБ → Шинэ, баталгаажсан; дүнг сервер тооцно; нөөцлөнө; Meta (Pixel-гүй) алгасна; хаяг автомат', async () => {
    const { order } = await O.createOrder(op, ub({ total: 1 } as never));
    expect(order).toMatchObject({ status: 'NEW', number: '00000001', subtotal: 20000, discount: 0, deliveryFee: 0, total: 20000, operatorName: op.name });
    expect(order.confirmedAt).not.toBeNull();
    expect(U.ymdOf(order.deliveryDate)).toBe(U.ubDay(new Date(), 1));
    expect((await db.stockReservation.findMany({ where: { orderId: order.id } })).map((r) => [r.variantId, r.qty])).toEqual([[v1, 2]]);
    expect((await db.metaEvent.findUniqueOrThrow({ where: { orderId: order.id } })).status).toBe('SKIPPED');
    const full = await Q.getOrder(op, order.id);
    expect(full.fullAddress).toBe('Улаанбаатар, Баянзүрх дүүрэг, 13-р хороо, Нарны хороолол 45-р байр, 56 тоот');
    expect(full.lines[0]).toMatchObject({ name: 'Гутлын үдээс', label: 'S', listPrice: 10000, unitPrice: 10000 });
    // Үнэ солигдсон ч хуучин захиалга хэвээр (#28)
    const p = await P.getProduct(sa, (await db.productVariant.findUniqueOrThrow({ where: { id: v1 } })).productId);
    await P.updateProduct(sa, p.id, { price: 12000 }, { reason: 'Үнэ өсгөв', version: p.version });
    expect((await Q.getOrder(op, order.id)).total).toBe(20000);
    // Хороо тодорхойгүй ч үүснэ
    const { order: o2 } = await O.createOrder(op, ub({ phone: '88112233', khoroo: null }));
    expect((await Q.getOrder(op, o2.id)).noKhoroo).toBe(true);
  });

  it('орон нутаг → Төлбөр хүлээж буй (хугацаатай); «Мөнгө орсон» зөвхөн ахлах; 2 удаа → 1; Meta илгээгдэнэ', async () => {
    await M.setMetaSettings(sa, { pixelId: '1234567890', token: 'EAAB' + 'x'.repeat(40) });
    const { order } = await O.createOrder(op, ub({ province: 'Дархан-Уул', district: null, khoroo: null, addressDetail: '3-р баг' }));
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(order.confirmedAt).toBeNull();
    expect(order.paymentDeadline!.getTime()).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);
    expect(await db.metaEvent.count()).toBe(0);
    await err(O.markPaid(op, order.id), 403);
    const [a, b] = await Promise.all([O.markPaid(lead, order.id), O.markPaid(lead, order.id)]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    const paid = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(paid).toMatchObject({ status: 'NEW', prepaid: true });
    expect(paid.createdAt.getTime()).toBe(order.createdAt.getTime());
    expect((await db.metaEvent.findUniqueOrThrow({ where: { orderId: order.id } })).status).toBe('PENDING');
    // УБ «Урьдчилгаа хүлээх»
    const { order: u } = await O.createOrder(op, ub({ phone: '88001122', prepaidWait: true }));
    expect(u.status).toBe('PENDING_PAYMENT');
  });

  it('пэйж сонгоогүй (#58) → «Пэйж сонгоогүй» нэрээр хадгална; сонгох жагсаалт, тохиргоонд харагдахгүй; сүүлийн пэйж өөрчлөгдөхгүй', async () => {
    const a = await O.createOrder(op, ub({ pageId: undefined }));
    const b = await O.createOrder(op2, ub({ phone: '88112233', pageId: '' }));
    const np = await db.page.findUniqueOrThrow({ where: { id: a.order.pageId } });
    expect(np.name).toBe('Пэйж сонгоогүй');
    expect(b.order.pageId).toBe(np.id); // нэг л систем пэйж
    expect((await db.user.findUniqueOrThrow({ where: { id: op.id } })).lastPageId).toBeNull();
    const mine = await A.pagesForActor(op);
    expect(mine.pages.map((x) => x.name)).not.toContain('Пэйж сонгоогүй');
    expect((await A.listAllPages(sa)).map((x) => x.name)).not.toContain('Пэйж сонгоогүй');
    await err(A.savePage(sa, { name: 'Пэйж сонгоогүй' }), 400);
    await err(A.savePage(sa, { id: np.id, name: 'Шинэ нэр' }), 400);
    // Хуваарилалттай оператор ч пэйжгүй захиалга үүсгэж чадна; дараа нь пэйж сонгож засна
    await A.setAssignment(lead, { userId: op.id, pageIds: [page2] });
    await O.createOrder(op, ub({ phone: '77112233', pageId: 0 }));
    const d = await Q.getOrder(op, a.order.id);
    const u = await O.updateOrder(op, a.order.id, { version: d.version, pageId: page2 });
    expect(u.order.pageId).toBe(page2);
    const rep = await R.pageReport(sa, {});
    expect(rep.rows.find((r) => r.label === 'Пэйж сонгоогүй')?.created).toBe(2);
  });

  it('давхар дарах / сүлжээ тасрах: нэг түлхүүрээр зэрэг 5 → 1 захиалга, 1 нөөц', async () => {
    const k = key();
    const rs = await Promise.all(Array.from({ length: 5 }, () => O.createOrder(op, ub({ idemKey: k }))));
    expect(new Set(rs.map((r) => r.order.id)).size).toBe(1);
    expect(rs.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await db.order.count()).toBe(1);
    expect(await db.stockReservation.count()).toBe(1);
  });

  it('давхар захиалга (#51): 2 утасны аль нь ч, хоёр чиглэлд; 2 оператор зэрэг → 1; цуцалсны дараа болно', async () => {
    const { order } = await O.createOrder(op, ub({ extraPhone: '88112233' }));
    await err(O.createOrder(op2, ub({ phone: '99112233' })), 409, 'duplicate_order');
    await err(O.createOrder(op2, ub({ phone: '88112233' })), 409, 'duplicate_order');
    await err(O.createOrder(op2, ub({ phone: '77001122', extraPhone: '99112233' })), 409, 'duplicate_order');
    const both = await Promise.allSettled([O.createOrder(op, ub({ phone: '95000001' })), O.createOrder(op2, ub({ phone: '95000002', extraPhone: '95000001' }))]);
    expect(both.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    await err(O.cancelOrder(op, order.id, { reason: 'CUSTOMER_CANCELLED', note: 'ab' }), 400, 'reason_required');
    await O.cancelOrder(op, order.id, { reason: 'CUSTOMER_CANCELLED', note: 'Үйлчлүүлэгч болисон' });
    await O.createOrder(op2, ub({ phone: '99112233' }));
  });

  it('үлдэгдэл: хүрэлцэхгүй бол 409; 2 оператор зэрэг сүүлийн барааг авбал 1; бараа хөдлөхгүй', async () => {
    await err(O.createOrder(op, ub({ lines: [{ variantId: v2, qty: 4 }] })), 409, 'insufficient_stock');
    const tries = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => O.createOrder(i % 2 ? op : op2, ub({ phone: String(91000000 + i), lines: [{ variantId: v2, qty: 2 }] }))));
    expect(tries.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await V.stockList(wh, { ids: [v2] })).items[0]).toMatchObject({ total: 3, reserved: 2, available: 1 });
    expect(await db.stockMove.count({ where: { variantId: v2 } })).toBe(1); // зөвхөн орлого
  });

  it('үнэ (#43 2): нэмэхгүй; бууруулахад шалтгаан; Супер админ «Шалгасан»', async () => {
    await err(O.createOrder(op, ub({ lines: [{ variantId: v1, qty: 1, unitPrice: 11000 }] })), 400, 'price_increase');
    await err(O.createOrder(op, ub({ lines: [{ variantId: v1, qty: 1, unitPrice: 8000 }] })), 400, 'discount_reason');
    const { order } = await O.createOrder(op, ub({ lines: [{ variantId: v1, qty: 2, unitPrice: 8000, discountReason: 'Байнгын үйлчлүүлэгч' }] }));
    expect(order).toMatchObject({ subtotal: 20000, discount: 4000, total: 16000 });
    await err(Q.discountReviewList(lead, {}), 403);
    const list = await Q.discountReviewList(sa, { unreviewed: true });
    expect(list.unreviewed).toBe(1);
    await Q.reviewDiscounts(sa, 'all');
    expect(await Q.unreviewedDiscounts()).toBe(0);
  });

  it('хүргэлтийн төлбөр (#43 1): багтаагүй бараа → захиалгад 1 удаа (УБ/орон нутаг); өөрчлөхөд шалтгаан', async () => {
    const { order } = await O.createOrder(op, ub({ lines: [{ variantId: vFee, qty: 2 }, { variantId: v1, qty: 1 }] }));
    expect(order).toMatchObject({ subtotal: 40000, deliveryFee: 5000, total: 45000, deliveryFeeEdited: false });
    const { order: r } = await O.createOrder(op, ub({ phone: '88990011', province: 'Орхон', district: null, khoroo: null, lines: [{ variantId: vFee, qty: 1 }] }));
    expect(r.deliveryFee).toBe(10000);
    await err(O.createOrder(op, ub({ phone: '88990022', lines: [{ variantId: vFee, qty: 1 }], deliveryFee: 0 })), 400, 'fee_reason');
    const { order: z } = await O.createOrder(op, ub({ phone: '88990022', lines: [{ variantId: vFee, qty: 1 }], deliveryFee: 0, feeReason: 'Ойрхон хаяг, үнэгүй' }));
    expect(z).toMatchObject({ deliveryFee: 0, deliveryFeeEdited: true, total: 15000 });
    expect(await Q.unreviewedDiscounts()).toBe(1);
  });

  it('хар жагсаалт: шалтгаан бичиж авна; удирдах — ахлах', async () => {
    await err(A.addBlacklist(op, { phone: '99112233', reason: 'Мөнгө өгөөгүй' }), 403);
    const e = await A.addBlacklist(lead, { phone: '99112233', reason: 'Мөнгө өгөөгүй' });
    const card = await Q.customerCard(op, ['99112233']);
    expect(card.blacklist).toHaveLength(1);
    await err(O.createOrder(op, ub()), 400, 'blacklist_confirm');
    const { order } = await O.createOrder(op, ub({ blacklistNote: 'Урьдчилгаа авна гэж тохиролцсон' }));
    expect(order.blacklistNote).toBe('Урьдчилгаа авна гэж тохиролцсон');
    await A.removeBlacklist(lead, e.id, { note: 'Төлбөрөө төлсөн' });
    expect((await Q.customerCard(op, ['99112233'])).blacklist).toHaveLength(0);
  });
});

describe('засвар (#48)', () => {
  it('бараа солих → нөөц зөрүүгээр; хүрэлцэхгүй бол юу ч өөрчлөгдөхгүй; хуучин version → stale; падаанд орсон → засахгүй (#66)', async () => {
    const { order } = await O.createOrder(op, ub({ lines: [{ variantId: v1, qty: 2 }] }));
    const r = await O.updateOrder(op2, order.id, { version: order.version, lines: [{ variantId: v2, qty: 2 }, { variantId: v1, qty: 1 }] });
    expect(r.changed).toBe(true);
    const res = await db.stockReservation.findMany({ where: { orderId: order.id }, orderBy: { variantId: 'asc' } });
    expect(res.map((x) => [x.variantId, x.qty])).toEqual([[v1, 1], [v2, 2]]);
    expect(r.order.total).toBe(30000);
    await err(O.updateOrder(op, order.id, { version: r.order.version, lines: [{ variantId: v2, qty: 4 }] }), 409, 'insufficient_stock');
    expect((await db.stockReservation.findMany({ where: { orderId: order.id } })).length).toBe(2);
    await err(O.updateOrder(op, order.id, { version: order.version, note: 'хуучин' }), 409, 'stale');
    // 2→3 болгоход зөвхөн 1 нэмэлт хэрэгтэй гэж зөв тоолно (v2: 3 байгаа, энэ захиалгад 2)
    const r2 = await O.updateOrder(op, order.id, { version: r.order.version, lines: [{ variantId: v2, qty: 3 }] });
    expect(r2.order.total).toBe(30000);
    await db.order.update({ where: { id: order.id }, data: { handoverId: 1 } });
    await err(O.updateOrder(op, order.id, { version: r2.order.version + 1, lines: [{ variantId: v1, qty: 1 }] }), 409);
    const fresh = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    await err(O.updateOrder(op, order.id, { version: fresh.version, lines: [{ variantId: v1, qty: 1 }] }), 409, 'in_handover');
    // #66: падаан үүссэн захиалгыг огт засахгүй (хуучин ERP шиг) — тэмдэглэл ч
    await err(O.updateOrder(op, order.id, { version: fresh.version, note: 'Орой 6-аас хойш' }), 409, 'in_handover');
  });

  it('зэрэг засвар + цуцлах → нэг нь; нөөц таарна', async () => {
    const { order } = await O.createOrder(op, ub());
    const rs = await Promise.allSettled([
      O.updateOrder(op, order.id, { version: order.version, lines: [{ variantId: v1, qty: 5 }] }),
      O.cancelOrder(op2, order.id, { reason: 'OTHER', note: 'Зэрэг цуцлах тест', version: order.version }),
    ]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    const res = await db.stockReservation.findMany({ where: { orderId: order.id } });
    if (o.status === 'CANCELLED') expect(res).toHaveLength(0); else expect(res.map((x) => x.qty)).toEqual([5]);
  });
});

describe('цуцлах, автомат цуцлалт, он сар өдөр', () => {
  it('хугацаа дууссан «Төлбөр хүлээж буй» автоматаар цуцлагдана, нөөц суллагдана; хугацаа сунгах', async () => {
    const { order } = await O.createOrder(op, ub({ prepaidWait: true }));
    const { order: o2 } = await O.createOrder(op, ub({ phone: '88001122', prepaidWait: true }));
    await db.order.updateMany({ where: { id: { in: [order.id, o2.id] } }, data: { paymentDeadline: new Date(Date.now() - 1000) } });
    await O.extendDeadline(lead, o2.id, { days: 3 });
    expect(await O.autoCancelExpired()).toBe(1);
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'CANCELLED', cancelReason: 'PAYMENT_TIMEOUT' });
    expect(await db.stockReservation.count({ where: { orderId: order.id } })).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: o2.id } })).status).toBe('PENDING_PAYMENT');
  });
  it('хол өдөр → «Он сар өдөртэй»; таб тоо; өнгөрсөн өдөр хориглоно', async () => {
    await err(O.createOrder(op, ub({ deliveryDate: U.ubDay(new Date(), -1) })), 400, 'bad_date');
    const { order } = await O.createOrder(op, ub({ deliveryDate: U.ubDay(new Date(), 5) }));
    await O.createOrder(op, ub({ phone: '88001100', deliveryDate: U.ubDay() }));
    const full = await Q.getOrder(op, order.id);
    expect(full).toMatchObject({ displayStatus: 'SCHEDULED', statusLabel: 'Он сар өдөртэй' });
    Q.bustCounts();
    const l = await Q.listOrders(op, { tab: 'SCHEDULED' });
    expect(l.items.map((i) => i.id)).toEqual([order.id]);
    expect(l.counts).toMatchObject({ SCHEDULED: 1, NEW: 1, todayDelivery: 1, today: 2 });
  });
});

describe('хайлт, үйлчлүүлэгчийн карт, цагийн мэдээ', () => {
  it('утасны хэсэг, дугаар, хаяг, барааны нэрээр; карт: өмнөх, идэвхтэй, сүүлийн хаяг', async () => {
    const { order } = await O.createOrder(op, ub({ note: 'Орой 6-аас хойш' }));
    await O.createOrder(op2, ub({ phone: '80112244', addressDetail: 'Зайсан 17-р байр', lines: [{ variantId: v2, qty: 1 }] }));
    const s = async (q: string) => (await Q.listOrders(op, { q })).items.map((i) => i.phone);
    expect(await s('2233')).toEqual(['99112233']);
    expect(await s('00000001')).toEqual(['99112233']);
    expect(await s('Зайсан')).toEqual(['80112244']);
    expect((await s('үдээс')).sort()).toEqual(['80112244', '99112233']);
    expect(await s('6-аас')).toEqual(['99112233']);
    const card = await Q.customerCard(op, ['9911 2233']);
    expect(card.active?.number).toBe(order.number);
    expect(card.lastAddress?.district).toBe('Баянзүрх');
    expect(card.stats.total).toBe(1);
  });
  it('цагийн мэдээ хуучин ERP-ийн логикоор: тухайн өдөр үүссэн, цуцлагдсан/төлбөр хүлээж буйгаас бусад, Улаанбаатарын цагаар; 21-ээс хойш → 21:00', async () => {
    const day0 = U.ubDayStart(U.ubDay()).getTime();
    const at = async (phone: string, ubHour: number, over: Record<string, unknown> = {}) => {
      const { order } = await O.createOrder(op, ub({ phone, ...over }));
      await db.order.update({ where: { id: order.id }, data: { createdAt: new Date(day0 + ubHour * 3_600_000) } });
      return order;
    };
    await at('88000001', 9.5);    // 09:30 → 11:00
    await at('88000002', 13.25);  // 13:15 → 15:00
    await at('88000003', 22.5);   // 22:30 → 21:00 (хуучин шиг)
    await at('88000004', 12, { province: 'Дархан-Уул', district: null, khoroo: null, addressDetail: '3-р баг' }); // төлбөр хүлээж буй → тоологдохгүй
    const c = await at('88000005', 10);
    await O.cancelOrder(op, c.id, { reason: 'CUSTOMER_CANCELLED', note: 'Тест цуцлалт', version: c.version });
    const h = await Q.hourlyReport(op);
    expect(h.cuts).toEqual([11, 13, 15, 18, 21]);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]!.cum).toEqual([1, 1, 2, 2, 3]);
    expect(h.total).toBe(3);
    // Өчигдрийн мэдээ хоосон
    expect((await Q.hourlyReport(op, U.ubDay(new Date(), -1))).total).toBe(0);
    // Пэйжийн тайлан «өдрөөр» — шөнийн 22:30-ын захиалга тухайн өдөрт орно (UTC-ээр биш)
    const rep = await R.pageReport(sa, { by: 'day' });
    expect(rep.rows.find((r) => r.key === U.ubDay())?.created).toBe(5);
  });
  it('цагийн мэдээний баг: ахлах тохируулна, оператор харна; нэг оператор хоёр багт орохгүй', async () => {
    await err(A.setOperatorTeams(op, { teams: [] }), 403);
    const r = await A.setOperatorTeams(lead, { teams: [{ name: 'Баг А', color: 'blue', members: [op.id] }, { name: 'Баг Б', color: 'xx', members: [op2.id] }] });
    expect(r.teams[1]!.color).toBe('slate');
    expect((await A.getOperatorTeams(op)).teams.map((t) => t.name)).toEqual(['Баг А', 'Баг Б']);
    expect((await A.getOperatorTeams(op)).canEdit).toBe(false);
    await err(A.setOperatorTeams(lead, { teams: [{ name: 'А', members: [op.id] }, { name: 'Б', members: [op.id] }] }), 400);
    await err(A.setOperatorTeams(lead, { teams: [{ name: 'А' }, { name: 'А' }] }), 400);
  });
  it('цагийн мэдээ бүх операторт, өөрийн мөр тодорсон; пэйжийн тайлан СА, маркетингт л', async () => {
    await O.createOrder(op, ub());
    await O.createOrder(op, ub({ phone: '88001122' }));
    await O.createOrder(op2, ub({ phone: '88001133', pageId: page2 }));
    const h = await Q.hourlyReport(op2);
    expect(h.rows.map((r) => [r.name, r.total, r.me])).toEqual([[op.name, 2, false], [op2.name, 1, true]]);
    await err(R.pageReport(op, {}), 403);
    await err(R.pageReport(lead, {}), 403);
    const mk = await actor(['MARKETING']);
    const rep = await R.pageReport(mk, {});
    expect(rep.rows.map((r) => [r.label, r.created, r.confirmed])).toEqual([['Гутал Шоп', 2, 2], ['Гоо сайхан МН', 1, 1]]);
    expect(JSON.stringify(rep)).not.toMatch(/total"?:\s*\d{5}/);
    const byOp = await R.pageReport(sa, { pageId: page1, by: 'operator' });
    expect(byOp.rows).toHaveLength(1);
  });
});

describe('дуудлагын бүртгэл (хуучин логик + #54)', () => {
  it('олноор нэмэх, 30 мин зай, 5 оролдлого, захиалга үүсэхэд автомат холбогдох, хаах шалтгаан, шилжүүлэх', async () => {
    const r = await C.createCallNotes(op, { phones: '99112233, 8800-1122\n80001133', variantId: v2, pageId: page1, note: 'Орой залгана' });
    expect(r.created).toBe(3);
    await err(C.createCallNotes(op, { phones: '123' }), 400, 'bad_phone');
    const [n1, n2, n3] = (await C.listCallNotes(op, {})).items.sort((a, b) => a.id - b.id);
    await C.attemptCall(op, n2!.id);
    await err(C.attemptCall(op, n2!.id), 409, 'too_soon');
    await db.callNote.update({ where: { id: n3!.id }, data: { attempts: 5 } });
    await err(C.attemptCall(op, n3!.id), 409, 'max_attempts');
    expect((await C.suggestCloseReason(op, n3!.id)).reason).toBe('NO_ANSWER');
    await err(C.closeCallNote(op, n3!.id, {}), 400, 'reason_required');
    await C.closeCallNote(op, n3!.id, { reason: 'NO_ANSWER' });
    // захиалга үүсэхэд автомат холбогдоно
    const { order } = await O.createOrder(op2, ub());
    expect(await db.callNote.findUniqueOrThrow({ where: { id: n1!.id } })).toMatchObject({ status: 'ORDERED', orderId: order.id });
    // шилжүүлэх хүсэлт → хүлээн авах
    await err(C.attemptCall(op2, n2!.id), 403);
    const t = await C.requestTransfer(op, n2!.id, { toUserId: op2.id });
    expect((await C.listCallNotes(op2, {})).incoming).toHaveLength(1);
    await err(C.decideTransfer(op, t.id, { accept: true }), 403);
    await C.decideTransfer(op2, t.id, { accept: true });
    expect((await db.callNote.findUniqueOrThrow({ where: { id: n2!.id } })).ownerId).toBe(op2.id);
    await err(C.reassignCallNotes(op, { ids: [n2!.id], toUserId: op.id }), 403);
    await C.reassignCallNotes(lead, { ids: [n2!.id], toUserId: op.id });
    // шинжилгээ: 1 захиалга болсон, 1 утсаа аваагүй, 1 залгаж байгаа
    await err(R.callAnalysis(op, {}), 403);
    const an = await R.callAnalysis(sa, { by: 'product' });
    expect(Object.fromEntries(an.buckets.map((b) => [b.key, b.n]))).toEqual({ CONVERTED: 1, NO_ANSWER: 1, OPEN: 1 });
    expect(an.table[0]).toMatchObject({ key: expect.stringContaining('Гутлын үдээс'), total: 3 });
    const phones = await R.callAnalysis(sa, { bucket: 'NO_ANSWER' });
    expect(phones.phones.map((p) => p.phone)).toEqual(['80001133']);
  });
});

describe('дуудлагын бүртгэл — бөөнөөр шилжүүлэх', () => {
  it('оператор олон бүртгэлээ нэг дор шилжүүлэх хүсэлт; хүлээн авагч бүгдийг нэг товчоор; бусдын бүртгэлийг шилжүүлэхгүй', async () => {
    await C.createCallNotes(op, { phones: '88000001 88000002 88000003' });
    await C.createCallNotes(op2, { phones: '88000004' });
    const mine = await db.callNote.findMany({ where: { ownerId: op.id } });
    const other = await db.callNote.findFirstOrThrow({ where: { ownerId: op2.id } });
    const r = await C.requestTransfers(op, { ids: [...mine.map((n) => n.id), other.id], toUserId: op2.id });
    expect(r).toEqual({ requested: 3, skipped: 1 });
    expect((await C.requestTransfers(op, { ids: mine.map((n) => n.id), toUserId: op2.id })).requested).toBe(0); // давхар хүсэлт үүсэхгүй
    await err(C.decideTransfers(op, { ids: 'all', accept: true }).then((x) => { if (x.decided) throw new Error('op-д ирээгүй'); throw new AppError(403, 'ok'); }), 403);
    expect((await C.decideTransfers(op2, { ids: 'all', accept: true })).decided).toBe(3);
    expect(await db.callNote.count({ where: { ownerId: op2.id } })).toBe(4);
  });
});

describe('Meta CAPI (#43 5)', () => {
  it('амжилттай → SENT (нэг удаа, event_id = дугаар); алдаа → дахин оролдлого; цуцлагдсан → SKIPPED', async () => {
    await M.setMetaSettings(sa, { pixelId: '1234567890', token: 'EAAB' + 'x'.repeat(40) });
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(fail ? 'bad' : '{"events_received":1}', { status: fail ? 500 : 200 });
    }));
    const { order } = await O.createOrder(op, ub());
    const { order: c } = await O.createOrder(op, ub({ phone: '88001122' }));
    await O.cancelOrder(op, c.id, { reason: 'OTHER', note: 'Тест цуцлалт' });
    let r = await M.processMetaQueue();
    expect(r).toEqual({ sent: 0, failed: 1 });
    const ev = await db.metaEvent.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(ev).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect((await db.metaEvent.findUniqueOrThrow({ where: { orderId: c.id } })).status).toBe('SKIPPED');
    fail = false;
    await db.metaEvent.update({ where: { id: ev.id }, data: { nextAttemptAt: new Date() } });
    r = await M.processMetaQueue();
    expect(r).toEqual({ sent: 1, failed: 0 });
    const body = calls.at(-1)!.body as { data: { event_id: string; custom_data: { value: number; currency: string }; user_data: { ph: string[] } }[]; access_token: string };
    expect(body.data[0]).toMatchObject({ event_id: `order_${order.number}`, custom_data: { value: 20000, currency: 'MNT' } });
    expect(body.data[0]!.user_data.ph[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(calls.at(-1)!.url).toContain('/1234567890/events');
    expect(await M.processMetaQueue()).toEqual({ sent: 0, failed: 0 });
    const s = await M.getMetaSettings(sa);
    expect(JSON.stringify(s)).not.toContain('x'.repeat(40));
    await err(M.getMetaSettings(lead), 403);
  });
});
