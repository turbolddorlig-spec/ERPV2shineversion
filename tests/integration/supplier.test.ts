import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';
import { bankPay } from '../helpers/bankPay';

/**
 * Модуль 7в — Нийлүүлэгч (#96–#98): падааны өдрөөр, авсан тоогоор, 1 ширхэгийн суутгал × тоо;
 * хөнгөлөлтийг хямдарсан бараа хүлээнэ; таны бараа/хүргэлтийн төлбөр орохгүй; нэг бараа нэг нийлүүлэгч;
 * шилжүүлсэн өдөр түгжигдэнэ; дараах буцаалт автоматаар дараагийн шилжүүлгээс хасагдана; үлдэгдэлд хүрэхгүй.
 */
let db: typeof import('@/lib/db').db;
let SP: typeof import('@/lib/services/supplier');
let P: typeof import('@/lib/services/products');
let W: typeof import('@/lib/services/stock/warehouses');
let D: typeof import('@/lib/services/stock/docs');
let V: typeof import('@/lib/services/stock/views');
let O: typeof import('@/lib/services/orders/orders');
let A: typeof import('@/lib/services/orders/admin');
let L: typeof import('@/lib/services/delivery/assign');
let H: typeof import('@/lib/services/delivery/handover');
let DR: typeof import('@/lib/services/delivery/driver');
let G: typeof import('@/lib/services/delivery/goods');
let U: typeof import('@/lib/ubdate');

beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  SP = await import('@/lib/services/supplier');
  P = await import('@/lib/services/products');
  W = await import('@/lib/services/stock/warehouses');
  D = await import('@/lib/services/stock/docs');
  V = await import('@/lib/services/stock/views');
  O = await import('@/lib/services/orders/orders');
  A = await import('@/lib/services/orders/admin');
  L = await import('@/lib/services/delivery/assign');
  H = await import('@/lib/services/delivery/handover');
  DR = await import('@/lib/services/delivery/driver');
  G = await import('@/lib/services/delivery/goods');
  U = await import('@/lib/ubdate');
});

let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(78000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
async function err(p: Promise<unknown>, status: number, code?: string) {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AppError); expect((e as AppError).status).toBe(status); if (code) expect((e as AppError).code).toBe(code); return; }
  throw new Error(`Алдаа гарах ёстой байсан (${status})`);
}
const key = () => randomUUID();

let sa: UserActor; let adm: UserActor; let op: UserActor; let lead: UserActor; let wh: UserActor; let acc: UserActor; let drv: UserActor;
let page1: number; let mine: number; let shoeP: number; let shoe: number; let sockP: number; let sock: number; let mainWh: number; let today: string;
let phoneSeq = 0;
const ub = (lines: unknown[]) => ({
  phone: String(99200000 + ++phoneSeq), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Тест 5-р байр',
  pageId: page1, lines, idemKey: key(), deliveryDate: today,
});
async function handTo(ids: number[]) {
  const h = await H.createHandover(wh, { driverId: drv.id, date: today, orderIds: ids });
  await H.prepareHandover(wh, h.id);
  const d = await H.handoverDetail(wh, h.id);
  for (const i of d.items) await H.setCheck(wh, h.id, { variantId: i.variantId, checked: true });
  await H.confirmHandover(wh, h.id);
  await H.setDriverCheck(drv, h.id, { variantId: 'all', checked: true });
  await H.receiveHandover(drv, h.id);
}
async function out(linesList: unknown[][]) {
  const ids: number[] = [];
  for (const l of linesList) ids.push((await O.createOrder(op, ub(l))).order.id);
  await L.assignOrders(lead, { ids, driverId: drv.id });
  await handTo(ids);
  return ids;
}
const lineOf = async (orderId: number, variantId: number) => (await db.orderLine.findFirstOrThrow({ where: { orderId, variantId } })).id;
const recOk = async () => { const r = await V.reconcile(sa, { fresh: true }); expect(r.ok).toBe(true); };

beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); adm = await actor(['ADMIN']); op = await actor(['OPERATOR']); lead = await actor(['DRIVER_LEAD']);
  wh = await actor(['WAREHOUSE']); acc = await actor(['ACCOUNTING']); drv = await actor(['DRIVER']);
  page1 = (await A.savePage(sa, { name: 'Гутал Шоп' })).id;
  const bag = await P.createProduct(sa, { code: 'BAG1', name: 'Таны цүнх', price: 30000 });
  mine = bag.variants[0]!.id;
  const sh = await P.createProduct(sa, { code: 'SH1', name: 'Нийлүүлэгчийн гутал', price: 20000 });
  shoeP = sh.id; shoe = sh.variants[0]!.id;
  const so = await P.createProduct(sa, { code: 'SO1', name: 'Нийлүүлэгчийн оймс', price: 5000 });
  sockP = so.id; sock = so.variants[0]!.id;
  mainWh = (await W.createWarehouse(sa, { name: 'Төв агуулах' })).id;
  await D.createReceipt(wh, { warehouseId: mainWh, lines: [{ variantId: mine, qty: 50 }, { variantId: shoe, qty: 50 }, { variantId: sock, qty: 50 }], idemKey: key() });
  today = U.ubDay();
  await H.setTrusted(acc, { driverId: drv.id, trusted: true });
});

async function shopWith(name = 'Гутлын дэлгүүр') {
  const { id } = await SP.saveShop(adm, { name, contactName: 'Бат', contactPhone: '99112233' });
  await SP.assignProduct(adm, { shopId: id, productId: shoeP });
  await SP.assignProduct(adm, { shopId: id, productId: sockP });
  await SP.saveDeduction(sa, { shopId: id, productId: shoeP, operatorCost: 1000, deliveryCost: 2000, marketingCost: 3000, otherCost: 0 });
  return id;
}

describe('өдрийн тооцоо — хуучин томъёо, падааны өдрөөр', () => {
  it('суутгал = 1 ширхэгийн суутгал × АВСАН тоо; таны бараа, хүргэлтийн төлбөр орохгүй; хөнгөлөлтийг хямдарсан бараа хүлээнэ; цуцалсан тоо', async () => {
    const shop = await shopWith();
    const [a, b, c, d] = await out([
      [{ variantId: mine, qty: 1 }, { variantId: shoe, qty: 2 }],                 // хамт хүргэгдсэн: цүнх танд, гутал нийлүүлэгчид
      [{ variantId: shoe, qty: 5 }],                                             // 5 захиалаад 3-ыг авсан
      [{ variantId: shoe, qty: 1, unitPrice: 17000, discountReason: 'Байнгын үйлчлүүлэгч' }, { variantId: mine, qty: 1, unitPrice: 24000, discountReason: 'Байнгын үйлчлүүлэгч' }],
      [{ variantId: shoe, qty: 1 }],
    ]);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await DR.deliverOrder(drv, b!, { payment: 'CASH', taken: { [await lineOf(b!, shoe)]: 3 } });
    await DR.deliverOrder(drv, c!, { payment: 'BANK' });
    // хүргэгдээгүй захиалга байгаа → шилжүүлэхгүй
    let day = await SP.dayView(adm, shop, today);
    expect(day.unfinished).toBe(1);
    await err(SP.transferDay(adm, { shopId: shop, date: today }), 400, 'unfinished');
    await DR.driverCancel(drv, d!, { note: 'Үйлчлүүлэгч утсаа авахгүй' });
    day = await SP.dayView(adm, shop, today);
    const l = day.lines.find((x) => x.code === 'SH1')!;
    // 2 + 3 + 1 = 6 ширхэг; 2×20000 + 3×20000 + 17000 = 117000; суутгал 6 × 6000 = 36000
    expect([l.qty, l.sales, l.deduction, l.net, l.cancelledQty]).toEqual([6, 117000, 36000, 81000, 3]);
    expect(day.lines.some((x) => x.code === 'BAG1')).toBe(false);
    expect([day.unfinished, day.totals.net, day.payable]).toEqual([0, 81000, 81000]);
    await err(SP.dayView(op, shop, today), 403);
    await recOk();
  });

  it('өөр өдрийн падаан энэ өдөрт орохгүй', async () => {
    const shop = await shopWith();
    const [a] = await out([[{ variantId: shoe, qty: 1 }]]);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    const day = await SP.dayView(sa, shop, today);
    expect(day.lines.find((x) => x.code === 'SH1')!.qty).toBe(1);
    const y = await SP.dayView(sa, shop, U.ubDay(new Date(), -1));
    expect(y.lines).toHaveLength(0);
  });
});

describe('нэг бараа — нэг нийлүүлэгч (давхар төлөхгүй)', () => {
  it('өөр дэлгүүрт оноосон барааг оноохгүй; хассаны дараа маргаашаас шинэ дэлгүүрт', async () => {
    const s1 = await shopWith('Дэлгүүр А');
    const { id: s2 } = await SP.saveShop(adm, { name: 'Дэлгүүр Б' });
    await err(SP.assignProduct(adm, { shopId: s2, productId: shoeP }), 409, 'already_assigned');
    await err(SP.assignProduct(adm, { shopId: s1, productId: shoeP }), 409, 'already_assigned');
    await err(SP.saveShop(adm, { name: 'Дэлгүүр А' }), 409);
    const a = await db.supplierProduct.findFirstOrThrow({ where: { shopId: s1, productId: shoeP } });
    const r = await SP.unassignProduct(adm, a.id);
    expect(r.until).toBe(U.ubDay(new Date(), 1));
    await err(SP.assignProduct(adm, { shopId: s2, productId: shoeP, fromDate: today }), 400);
    await SP.assignProduct(adm, { shopId: s2, productId: shoeP, fromDate: r.until });
    // DB хамгаалалт: нээлттэй хоёр хувиарлалт байж болохгүй
    await expect(db.supplierProduct.create({ data: { shopId: s1, productId: shoeP, fromDate: U.dateOnly(today), createdByName: 'x' } })).rejects.toThrow();
    // өнөөдрийн падаан хуучин (А) дэлгүүрт
    const [o] = await out([[{ variantId: shoe, qty: 1 }]]);
    await DR.deliverOrder(drv, o!, { payment: 'CASH' });
    expect((await SP.dayView(adm, s1, today)).totals.qty).toBe(1);
    expect((await SP.dayView(adm, s2, today)).totals.qty).toBe(0);
  });
});

describe('гараар суутгал (зөвхөн Супер админ), шилжүүлэх ба түгжээ', () => {
  it('Админ гараар засахгүй (403); Супер админ засна, түүхэнд; шилжүүлсэн өдөр 423, дахин шилжүүлэхгүй', async () => {
    const shop = await shopWith();
    const [a] = await out([[{ variantId: shoe, qty: 2 }]]);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    const shoeLine = (await SP.dayView(adm, shop, today)).lines[0]!;
    await err(SP.overrideDay(adm, { shopId: shop, date: today, productId: shoeLine.productId, operatorCost: 0, deliveryCost: 0, marketingCost: 0, otherCost: 0 }), 403);
    await SP.overrideDay(sa, { shopId: shop, date: today, productId: shoeLine.productId, operatorCost: 1000, deliveryCost: 1000, marketingCost: 1000, otherCost: 500, note: 'Тохиролцсон' });
    let day = await SP.dayView(adm, shop, today);
    // Аудит Б19: 1 ширхэгийн суутгал (3,500₮) × 2 ширхэг
    expect([day.lines[0]!.manual, day.lines[0]!.qty, day.lines[0]!.deduction, day.totals.net]).toEqual([true, 2, 7000, 33000]);
    expect(await db.auditLog.count({ where: { action: 'supplier.deduction_override' } })).toBe(1);
    const t = await SP.transferDay(adm, { shopId: shop, date: today, version: day.version });
    expect(t.payable).toBe(33000);
    day = await SP.dayView(adm, shop, today);
    expect([day.status, day.payable, day.transferredByName]).toEqual(['TRANSFERRED', 33000, adm.name]);
    await err(SP.overrideDay(sa, { shopId: shop, date: today, productId: shoeLine.productId, operatorCost: 0, deliveryCost: 0, marketingCost: 0, otherCost: 0 }), 423);
    await err(SP.transferDay(adm, { shopId: shop, date: today }), 409, 'already_transferred');
    // тохиргоо өөрчилсөн ч шилжүүлсэн өдөр өөрчлөгдөхгүй
    await err(SP.saveDeduction(adm, { shopId: shop, productId: shoeP, operatorCost: 9000, deliveryCost: 0, marketingCost: 0, otherCost: 0 }), 403);
    await SP.saveDeduction(sa, { shopId: shop, productId: shoeP, operatorCost: 9000, deliveryCost: 0, marketingCost: 0, otherCost: 0 });
    expect((await SP.dayView(adm, shop, today)).payable).toBe(33000);
    await err(SP.undoTransfer(adm, { shopId: shop, date: today }), 403);
    await SP.undoTransfer(sa, { shopId: shop, date: today });
    expect((await SP.dayView(adm, shop, today)).status).toBe('OPEN');
  });
});

describe('шилжүүлсний дараах буцаалт — автоматаар, зөвхөн нийлүүлэгчийн барааны дүнгээр', () => {
  it('#124-2: шилжүүлсний дараа нэмж олгосон мөр дахин буцвал яг тэр дүнгээр хасна (+14,000 → −14,000)', async () => {
    const shop = await shopWith();
    const [a, b] = await out([[{ variantId: shoe, qty: 1 }], [{ variantId: shoe, qty: 1 }]]);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await DR.driverCancel(drv, b!, { note: 'Утас авахгүй байна' });
    await SP.transferDay(adm, { shopId: shop, date: today });
    expect((await SP.dayView(adm, shop, today)).payable).toBe(14000);
    // б-г нягтлан «Хүргэсэн» болгосон мэт → нэмэгдэл +14,000
    await db.order.update({ where: { id: b! }, data: { status: 'DELIVERED', deliveredAt: new Date(), cancelReason: null, cancelledAt: null } });
    await SP.syncAdjustments(shop);
    const add = await db.supplierAdjustment.findFirstOrThrow({ where: { kind: 'ADDITION' } });
    expect([add.qty, add.amount]).toEqual([1, 14000]);
    // дахин цуцлагдав → буцаалт −14,000 (өмнө нь +6,000 гэж буруу гардаг байв)
    await db.order.update({ where: { id: b! }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await SP.syncAdjustments(shop);
    const ref = await db.supplierAdjustment.findFirstOrThrow({ where: { kind: 'REFUND' } });
    expect([ref.qty, ref.sales, ref.deduction, ref.amount]).toEqual([1, 20000, 6000, -14000]);
    expect((await SP.shopDetail(adm, shop)).balance.pendingAdj).toBe(0);
  });

  it('хүргэсний дараа цуцалсан → буцаалт (борлуулалт − суутгал), шалтгаантай; дараагийн шилжүүлгээс хасагдана; хүрэхгүй бол үлдэгдэл шилжинэ', async () => {
    const shop = await shopWith();
    const [a, b] = await out([
      [{ variantId: mine, qty: 1 }, { variantId: shoe, qty: 2 }],
      [{ variantId: shoe, qty: 1 }],
    ]);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await DR.deliverOrder(drv, b!, { payment: 'CASH' });
    await SP.transferDay(adm, { shopId: shop, date: today });
    expect((await SP.dayView(adm, shop, today)).payable).toBe(3 * 20000 - 3 * 6000); // 42000
    // а захиалгыг хүргэсний дараа буцаасан (цүнх + 2 гутал)
    await DR.undoDelivery(drv, a!, { note: 'Үйлчлүүлэгч буцааж өгсөн' });
    const det = await SP.shopDetail(adm, shop);
    const refund = det.adjustments.find((x) => x.kind === 'REFUND')!;
    // зөвхөн 2 гутал: 40000 − 12000 = 28000 (цүнх 30000 орохгүй)
    expect([refund.qty, refund.sales, refund.deduction, refund.amount]).toEqual([2, 40000, 12000, -28000]);
    expect(refund.reason).toContain('буцаасан');
    expect(det.balance.pendingAdj).toBe(-28000);
    // давхар үүсгэхгүй
    await SP.syncAdjustments(shop);
    expect(await db.supplierAdjustment.count({ where: { kind: 'REFUND' } })).toBe(1);
    // нийлүүлэгч өөрөө ч шалтгааныг харна
    const supUser = await actor(['SUPPLIER']);
    await db.supplierShop.update({ where: { id: shop }, data: { userId: supUser.id } });
    const mineView = await SP.shopDetail(supUser, 999999);
    expect(mineView.shop.id).toBe(shop);
    expect(mineView.adjustments[0]!.reason).toContain('буцаасан');
    expect(mineView.login).toBeNull();
    // дараагийн өдөр: 1 гутал (14000) − 28000 → 0 шилжүүлнэ, 14000 өр дараагийнх руу
    await db.$executeRaw`UPDATE "SupplierDay" SET date = ${U.dateOnly(U.ubDay(new Date(), -1))}::date WHERE "shopId" = ${shop} AND date = ${U.dateOnly(today)}::date`;
    await db.$executeRaw`UPDATE "Handover" SET date = ${U.dateOnly(U.ubDay(new Date(), -1))}::date`;
    await db.$executeRaw`UPDATE "SupplierProduct" SET "fromDate" = ${U.dateOnly(U.ubDay(new Date(), -1))}::date`;
    const [c] = await out([[{ variantId: shoe, qty: 1 }]]);
    await DR.deliverOrder(drv, c!, { payment: 'CASH' });
    const d2 = await SP.dayView(adm, shop, today);
    expect([d2.totals.net, d2.adjTotal, d2.payable, d2.carry]).toEqual([14000, -28000, 0, -14000]);
    await SP.transferDay(adm, { shopId: shop, date: today });
    const carry = await db.supplierAdjustment.findFirstOrThrow({ where: { kind: 'CARRY' } });
    expect([carry.amount, carry.appliedDayId]).toEqual([-14000, null]);
    await err(SP.undoTransfer(sa, { shopId: shop, date: U.ubDay(new Date(), -1) }), 400);
    // буцаалт шилжүүлэгт тооцогдсон тул эх өдрийг буцаахгүй
    await recOk();
    // нийлүүлэгч бусдыг засахгүй
    await err(SP.transferDay(supUser, { shopId: shop, date: today }), 403);
    await err(SP.overview(supUser), 403);
  });
});

describe('анхдагч суутгал (#100) — бүх дэлгүүрт нэг, бараа нэмэхэд автоматаар', () => {
  it('зөвхөн Супер админ; шинэ бараанд автоматаар; «бүгдийг шинэчлэх»; шилжүүлсэн өдөр өөрчлөгдөхгүй', async () => {
    await err(SP.setDefaults(adm, { operatorCost: 1000 }), 403);
    await SP.setDefaults(sa, { operatorCost: 1000, deliveryCost: 2000, marketingCost: 1500, otherCost: 500, otherNote: 'Савлагаа' });
    const { id: shop } = await SP.saveShop(adm, { name: 'Анхдагч дэлгүүр' });
    await SP.assignProduct(adm, { shopId: shop, productId: shoeP });
    const d1 = await db.supplierDeduction.findUniqueOrThrow({ where: { shopId_productId: { shopId: shop, productId: shoeP } } });
    expect([d1.operatorCost, d1.deliveryCost, d1.marketingCost, d1.otherCost, d1.otherNote]).toEqual([1000, 2000, 1500, 500, 'Савлагаа']);
    // Супер админ бараа тус бүрийн дүнг засна
    await SP.saveDeduction(sa, { shopId: shop, productId: shoeP, operatorCost: 3000, deliveryCost: 0, marketingCost: 0, otherCost: 0 });
    const [o] = await out([[{ variantId: shoe, qty: 2 }]]);
    await DR.deliverOrder(drv, o!, { payment: 'CASH' });
    await SP.transferDay(adm, { shopId: shop, date: today });
    expect((await SP.dayView(adm, shop, today)).totals.deductions).toBe(6000);
    // анхдагчийг өөрчлөөд «бүгдийг шинэчлэх» → оноогдсон бараа шинэчлэгдэнэ, шилжүүлсэн өдөр хэвээр
    await SP.assignProduct(adm, { shopId: shop, productId: sockP });
    const r = await SP.setDefaults(sa, { operatorCost: 500, deliveryCost: 500, marketingCost: 0, otherCost: 0, applyAll: true });
    expect(r.updated).toBe(2);
    expect((await db.supplierDeduction.findUniqueOrThrow({ where: { shopId_productId: { shopId: shop, productId: shoeP } } })).operatorCost).toBe(500);
    expect((await SP.dayView(adm, shop, today)).totals.deductions).toBe(6000);
    expect(await db.auditLog.count({ where: { action: 'supplier.default_deduction' } })).toBe(2);
    expect((await SP.overview(adm)).defaults.operatorCost).toBe(500);
  });
});

describe('мөнгө орсон захиалга (#102) — хуучин логик, цуцалж дахин үүсгэхгүй', () => {
  it('өчигдөр үүссэн төлбөр хүлээж буй → мөнгө орсон: ижил дугаар «Шинэ», хүргэх өдөр = өнөөдөр, өнөөдрийн захиалгад тоологдоно; картын шүүлтүүр', async () => {
    const shop = await shopWith();
    const yest = U.ubDay(new Date(), -1);
    const p = (await O.createOrder(op, { ...ub([{ variantId: shoe, qty: 1 }]), prepaidWait: true })).order;
    expect(p.status).toBe('PENDING_PAYMENT');
    await db.order.update({ where: { id: p.id }, data: { createdAt: new Date(U.ubDayStart(yest).getTime() + 20 * 3600_000), deliveryDate: U.dateOnly(yest) } });
    // төлбөр хүлээж буй — тоологдохгүй
    let ov = await SP.overview(adm);
    expect([ov.orderDays[0]!.total, ov.orderDays[1]!.total]).toEqual([0, 0]);
    await bankPay(p.id);
    const r = { order: await db.order.findUniqueOrThrow({ where: { id: p.id } }) };
    expect([r.order.number, r.order.status, U.ymdOf(r.order.deliveryDate), r.order.prepaid]).toEqual([p.number, 'NEW', today, true]);
    expect(await db.order.count()).toBe(1); // цуцалж дахин үүсгээгүй
    // «Шинэ» байгаад цуцлагдсан, он сар өдөртэй — тоологдохгүй
    const c = (await O.createOrder(op, ub([{ variantId: shoe, qty: 1 }]))).order;
    await O.cancelOrder(op, c.id, { reason: 'CUSTOMER_CANCELLED', note: 'Үйлчлүүлэгч болисон' });
    await O.createOrder(op, { ...ub([{ variantId: shoe, qty: 1 }]), deliveryDate: U.ubDay(new Date(), 5) });
    await O.createOrder(op, ub([{ variantId: mine, qty: 1 }]));
    ov = await SP.overview(adm);
    // өнөөдөр: мөнгө орсон (гутал) + цүнхтэй энгийн = 2; өчигдөр 0
    expect([ov.orderDays[0]!.total, ov.orderDays[0]!.pending, ov.orderDays[1]!.total]).toEqual([2, 2, 0]);
    expect(ov.orderDays[0]!.shops!.find((x) => x.id === shop)).toMatchObject({ total: 1, amount: 20000 });
    const det = await SP.shopDetail(adm, shop);
    expect([det.orderDays[0]!.total, det.orderDays[0]!.amount]).toEqual([1, 20000]);
  });
});

describe('нэвтрэх эрх, самбар', () => {
  it('нийлүүлэгчид нэвтрэх эрх (түр нууц үг, hash); идэвхгүй болгоход нэвтрэхгүй; самбар', async () => {
    const shop = await shopWith();
    const r = await SP.createLogin(adm, { shopId: shop, name: 'Бат нийлүүлэгч', phone: '88776655' });
    expect(r.temporaryPassword).toBeTruthy();
    const u = await db.user.findUniqueOrThrow({ where: { phone: '88776655' } });
    expect([u.roles, u.passwordHash.includes(r.temporaryPassword!)]).toEqual([['SUPPLIER'], false]);
    await err(SP.createLogin(adm, { shopId: shop, phone: '88776656' }), 409);
    const ov = await SP.overview(adm);
    expect(ov.shops[0]).toMatchObject({ name: 'Гутлын дэлгүүр', hasLogin: true, productCount: 2 });
    expect(ov.orderDays).toHaveLength(3);
    await SP.setShopActive(adm, shop, false);
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).isActive).toBe(false);
    const sup: UserActor = { id: u.id, name: u.name, roles: u.roles };
    await err(SP.shopDetail(sup), 404);
  });
});
