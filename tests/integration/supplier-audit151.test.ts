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

const shift = async (days: number) => {
  const d = U.dateOnly(U.ubDay(new Date(), days));
  await db.$executeRaw`UPDATE "Handover" SET date = ${d}::date`;
};

/** Аудит #151 — нийлүүлэгч: хуучин огноо (90 хоног, шалтгаан), суутгал дагуулах / өнөөдрөөс, өртэй өдөр автоматаар хасах, тусгаарлалт */
describe('#151 нийлүүлэгч', () => {
  it('хуучин огноогоор оноох: 90 хоног хүртэл, шалтгаантай; 90 хоногоос хуучин өдрийг шилжүүлэхгүй', async () => {
    const shop = await shopWith();
    const bagP = (await db.productVariant.findUniqueOrThrow({ where: { id: mine } })).productId;
    await err(SP.assignProduct(adm, { shopId: shop, productId: bagP, fromDate: '2020-01-01', reason: 'Хуучин' }), 400, 'too_old');
    await err(SP.assignProduct(adm, { shopId: shop, productId: bagP, fromDate: U.ubDay(new Date(), -10) }), 400, 'reason_required');
    await SP.assignProduct(adm, { shopId: shop, productId: bagP, fromDate: U.ubDay(new Date(), -10), reason: 'Нийлүүлэгчийн бараа байсан, хожуу бүртгэв' });
    const au = await db.auditLog.findFirstOrThrow({ where: { action: 'supplier.product_assigned' }, orderBy: { at: 'desc' } });
    expect(JSON.stringify(au.details)).toContain('хожуу бүртгэв');
    await err(SP.transferDay(adm, { shopId: shop, date: '2021-05-05' }), 400, 'too_old');
  });

  it('бараа шинэ дэлгүүрт шилжихэд Супер админы суутгал дагана', async () => {
    const s1 = await shopWith('Дэлгүүр А');
    const a = await db.supplierProduct.findFirstOrThrow({ where: { shopId: s1, productId: shoeP } });
    const r = await SP.unassignProduct(adm, a.id);
    const { id: s2 } = await SP.saveShop(adm, { name: 'Дэлгүүр А2' });
    await SP.assignProduct(adm, { shopId: s2, productId: shoeP, fromDate: r.until });
    const d = await db.supplierDeduction.findUniqueOrThrow({ where: { shopId_productId: { shopId: s2, productId: shoeP } } });
    expect([d.operatorCost, d.deliveryCost, d.marketingCost, d.otherCost]).toEqual([1000, 2000, 3000, 0]);
  });

  it('суутгал өөрчлөхөд өмнөх шилжүүлээгүй өдрийн дүн өөрчлөгдөхгүй (өнөөдрөөс)', async () => {
    const shop = await shopWith();
    await db.$executeRaw`UPDATE "SupplierProduct" SET "fromDate" = ${U.dateOnly(U.ubDay(new Date(), -5))}::date`;
    const [a] = await out([[{ variantId: shoe, qty: 1 }]]);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await shift(-1);
    const yest = U.ubDay(new Date(), -1);
    const before = (await SP.dayView(adm, shop, yest)).totals.net;
    expect(before).toBe(20000 - 6000);
    await SP.saveDeduction(sa, { shopId: shop, productId: shoeP, operatorCost: 0, deliveryCost: 0, marketingCost: 0, otherCost: 0 });
    expect((await SP.dayView(adm, shop, yest)).totals.net).toBe(before);
  });

  it('өртэй (хасах) өмнөх өдөр дараагийн шилжүүлгээс автоматаар хасагдана — тайлбартай', async () => {
    const shop = await shopWith();
    await SP.saveDeduction(sa, { shopId: shop, productId: sockP, operatorCost: 4000, deliveryCost: 4000, marketingCost: 0, otherCost: 0 });
    await db.$executeRaw`UPDATE "SupplierProduct" SET "fromDate" = ${U.dateOnly(U.ubDay(new Date(), -5))}::date`;
    const [a] = await out([[{ variantId: sock, qty: 3 }]]);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await shift(-1);
    const [b] = await out([[{ variantId: shoe, qty: 1 }]]);
    await DR.deliverOrder(drv, b!, { payment: 'CASH' });
    const yest = U.ubDay(new Date(), -1);
    const neg = (await SP.dayView(adm, shop, yest)).totals.net;
    expect(neg).toBe(3 * 5000 - 3 * 8000); // −9000
    const t = await SP.transferDay(adm, { shopId: shop, date: today });
    expect(t.netted).toEqual([{ date: yest, amount: -9000 }]);
    expect(t.payable).toBe(14000 - 9000);
    const carry = await db.supplierAdjustment.findFirstOrThrow({ where: { shopId: shop, kind: 'CARRY' } });
    expect(carry.reason).toContain('автоматаар хасагдав');
    expect((await SP.dayView(adm, shop, yest)).status).toBe('TRANSFERRED');
  });

  it('Супер админы өдрийн гарын суутгал дараа нэмэгдсэн хүргэлтэд ч үйлчилнэ', async () => {
    const shop = await shopWith();
    const [a, b] = await out([[{ variantId: shoe, qty: 1 }], [{ variantId: shoe, qty: 1 }]]);
    await DR.deliverOrder(drv, a!, { payment: 'CASH' });
    await DR.driverCancel(drv, b!, { note: 'Утас авахгүй байна' });
    const v0 = (await SP.dayView(adm, shop, today)).version;
    await SP.overrideDay(sa, { shopId: shop, date: today, productId: shoeP, operatorCost: 15000, deliveryCost: 0, marketingCost: 0, otherCost: 0, note: 'Тусгай', version: v0 });
    const v1 = (await SP.dayView(adm, shop, today)).version;
    await SP.transferDay(adm, { shopId: shop, date: today, version: v1 });
    await db.order.update({ where: { id: b! }, data: { status: 'DELIVERED', deliveredAt: new Date(), cancelReason: null, cancelledAt: null } });
    await SP.syncAdjustments(shop);
    const add = await db.supplierAdjustment.findFirstOrThrow({ where: { kind: 'ADDITION' } });
    expect([add.qty, add.sales, add.deduction, add.amount]).toEqual([1, 20000, 15000, 5000]);
  });

  it('нэг нийлүүлэгч нөгөөгийнхөө «Захиалсан» тэмдэглэлийг харах, цуцлахгүй', async () => {
    const SO = await import('@/lib/services/supplier-outflow');
    const s1 = await shopWith('Дэлгүүр А');
    const ua = await actor(['SUPPLIER']); await db.supplierShop.update({ where: { id: s1 }, data: { userId: ua.id } });
    const ro = await SO.supplierReorder(ua, null, { productId: shoeP, qty: 10, note: 'А-ийн нууц тэмдэглэл' });
    const a = await db.supplierProduct.findFirstOrThrow({ where: { shopId: s1, productId: shoeP } });
    await db.supplierProduct.update({ where: { id: a.id }, data: { toDate: U.dateOnly(today) } });
    const { id: s2 } = await SP.saveShop(adm, { name: 'Дэлгүүр Б' });
    await SP.assignProduct(adm, { shopId: s2, productId: shoeP, fromDate: today });
    const ub2 = await actor(['SUPPLIER']); await db.supplierShop.update({ where: { id: s2 }, data: { userId: ub2.id } });
    const det = await SO.supplierReorderDetail(ub2, null, shoeP);
    expect(det.history).toEqual([]);
    await err(SO.supplierReorderCancel(ub2, null, ro.id), 403);
  });
});
