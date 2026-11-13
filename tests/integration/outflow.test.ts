import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** Модуль 7г — Барааны гарц, бүүстийн ашиг, анхааруулга, ажлын цонх, үнэлгээ (#104–#110) */
let db: typeof import('@/lib/db').db;
let OF: typeof import('@/lib/services/outflow');
let P: typeof import('@/lib/services/products');
let W: typeof import('@/lib/services/stock/warehouses');
let D: typeof import('@/lib/services/stock/docs');
let O: typeof import('@/lib/services/orders/orders');
let A: typeof import('@/lib/services/orders/admin');
let S: typeof import('@/lib/services/salary');
let U: typeof import('@/lib/ubdate');

beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  OF = await import('@/lib/services/outflow');
  P = await import('@/lib/services/products');
  W = await import('@/lib/services/stock/warehouses');
  D = await import('@/lib/services/stock/docs');
  O = await import('@/lib/services/orders/orders');
  A = await import('@/lib/services/orders/admin');
  S = await import('@/lib/services/salary');
  U = await import('@/lib/ubdate');
});
let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(77000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
async function err(p: Promise<unknown>, status: number, code?: string) {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AppError); expect((e as AppError).status).toBe(status); if (code) expect((e as AppError).code).toBe(code); return; }
  throw new Error(`Алдаа гарах ёстой байсан (${status})`);
}
const H = 3_600_000;
let sa: UserActor; let adm: UserActor; let lead: UserActor; let mk: UserActor; let mk2: UserActor; let op: UserActor; let acc: UserActor;
let page1: number; let page2: number; let prod: number; let v: number; let today: string; let yest: string;
let ph = 0;
async function orderAt(over: { daysAgo?: number; hour?: number; status?: 'NEW' | 'CANCELLED'; cancelDaysAgo?: number; qty?: number; pageId?: number } = {}) {
  const { order } = await O.createOrder(op, { phone: String(99300000 + ++ph), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Тест 5-р байр',
    pageId: over.pageId ?? page1, lines: [{ variantId: v, qty: over.qty ?? 1 }], idemKey: randomUUID(), deliveryDate: U.ubDay(new Date(), 1) });
  const at = new Date(U.ubDayStart(U.ubDay(new Date(), -(over.daysAgo ?? 0))).getTime() + (over.hour ?? 10) * H);
  const data: Record<string, unknown> = { createdAt: at, confirmedAt: at };
  if (over.status === 'CANCELLED') Object.assign(data, { status: 'CANCELLED', cancelledAt: new Date(U.ubDayStart(U.ubDay(new Date(), -(over.cancelDaysAgo ?? over.daysAgo ?? 0))).getTime() + 20 * H) });
  await db.order.update({ where: { id: order.id }, data });
  return order.id;
}
const order = orderAt;
/** Бүүстийг өгсөн мөчид асаасан мэт тохируулна */
async function boostAt(zones: number, at: Date, dollar = 5) {
  await OF.saveBoost(mk, { productId: prod, dollar, zones });
  await db.boostEvent.updateMany({ where: { productId: prod }, data: { at } });
  await db.productMarketing.update({ where: { productId: prod }, data: { boostOnAt: zones > 0 ? at : null } });
  OF.bustOutflowCache();
}

beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); adm = await actor(['ADMIN']); lead = await actor(['MARKETING_LEAD']); mk = await actor(['MARKETING']); mk2 = await actor(['MARKETING']);
  op = await actor(['OPERATOR']); acc = await actor(['ACCOUNTING']);
  page1 = (await A.savePage(sa, { name: 'greenshopy' })).id; page2 = (await A.savePage(sa, { name: 'blackshopy' })).id;
  const p = await P.createProduct(sa, { code: 'B1', name: 'Бүүстийн бараа', price: 20000 });
  prod = p.id; v = p.variants[0]!.id;
  await db.product.update({ where: { id: prod }, data: { costPrice: 4000 } });
  const wh = (await W.createWarehouse(sa, { name: 'Төв' })).id;
  await D.createReceipt(sa, { warehouseId: wh, lines: [{ variantId: v, qty: 500 }], idemKey: randomUUID() });
  today = U.ubDay(); yest = U.ubDay(new Date(), -1);
  OF.bustOutflowCache(); OF.bustTable();
});

describe('7 хоногийн гарц — тоолох дүрэм (#104)', () => {
  it('тэр өдөртөө цуцлагдсан орохгүй, өдөр өнгөрсний дараах цуцлалт буулгахгүй; төлбөр хүлээж буй орохгүй; дундаж = ÷7; эрх', async () => {
    await order({ qty: 2 });                                         // өнөөдөр 2
    await order({ status: 'CANCELLED' });                            // өнөөдөр үүсээд цуцлагдсан → 0
    await order({ daysAgo: 1, qty: 3 });                             // өчигдөр 3
    await order({ daysAgo: 1, status: 'CANCELLED', cancelDaysAgo: 0 }); // өчигдөр, өнөөдөр цуцлагдсан → өчигдөрт тоологдоно (1)
    await O.createOrder(op, { phone: '99399999', province: 'Дархан-Уул', district: null, khoroo: null, addressDetail: '3-р баг', pageId: page1, lines: [{ variantId: v, qty: 5 }], idemKey: randomUUID(), deliveryDate: U.ubDay(new Date(), 1) }); // төлбөр хүлээж буй
    const t = await OF.outflowTable(mk, {});
    const r = t.rows.find((x) => x.id === prod)!;
    expect(r.daily.slice(0, 2)).toEqual([2, 4]);
    expect([r.weekTotal, r.avg]).toEqual([6, 0.9]);
    expect([t.totals.today, t.totals.yesterday]).toEqual([2, 4]);
    expect(r.profit).toBeUndefined(); // маркетинг мөнгө харахгүй
    await err(OF.outflowTable(op, {}), 403);
    const pages = await OF.productPages(mk, prod);
    expect(pages.pages[0]).toMatchObject({ name: 'greenshopy', total: 6 });
  });
});

describe('бараа дуусах анхааруулга (#118)', () => {
  it('боломжтой ≤ өдрийн хурд → 🟠 «дуусах дөхсөн»; 0 → 🔴 «дууссан»; бүүст унтраахад арилна', async () => {
    await boostAt(1, U.ubDayStart(U.ubDay(new Date(), -5)));
    for (let d = 1; d <= 3; d++) for (let i = 0; i < 10; i++) await order({ daysAgo: d }); // өдөрт 10
    // үлдэгдэл: 500 − 30 захиалгад = 470 боломжтой → анхааруулгагүй
    let al = await OF.computeAlerts(true);
    expect(al.find((a) => a.productId === prod)?.reasons.some((r) => r.includes('Бараа дуус'))).toBeFalsy();
    // 462-ыг нөөцөлж 8 үлдээнэ (өдөрт 10 > 8)
    await O.createOrder(op, { phone: '99377777', province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Тест 5-р байр', pageId: page1, lines: [{ variantId: v, qty: 462 }], idemKey: randomUUID(), deliveryDate: U.ubDay(new Date(), 1) });
    await db.order.updateMany({ where: { lines: { some: { qty: 462 } } }, data: { confirmedAt: new Date(Date.now() - 400 * 86_400_000) } }); // гарцад тооцохгүй
    al = await OF.computeAlerts(true);
    expect(al.find((a) => a.productId === prod)?.reasons.join(' ')).toContain('Бараа дуусах дөхсөн: боломжтой 8, өдөрт ~10');
    await OF.saveBoost(mk, { productId: prod, zones: 0 });
    expect((await OF.computeAlerts(true)).find((a) => a.productId === prod)).toBeUndefined();
  });
});

describe('бараа татах — нөөц хоног (#119, зөвхөн СА)', () => {
  /** Үлдэгдлээс n ширхэгийг нөөцөлнө (гарцад тооцохгүй хуучин захиалгаар) */
  async function reserve(n: number) {
    const { order: o } = await O.createOrder(op, { phone: String(99400000 + ++ph), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Тест', pageId: page1, lines: [{ variantId: v, qty: n }], idemKey: randomUUID(), deliveryDate: U.ubDay(new Date(), 1) });
    await db.order.update({ where: { id: o.id }, data: { confirmedAt: new Date(Date.now() - 400 * 86_400_000) } });
  }
  it('нөөц = боломжтой ÷ хурд; ≤15 → 🟠, ≤7 → 🔴; «Захиалсан» → 🚚 (сануулгагүй); хугацаа хэтэрвэл ⏰; орлого ормогц дахин эхэлнэ', async () => {
    for (let d = 1; d <= 3; d++) for (let i = 0; i < 10; i++) await order({ daysAgo: d }); // өдөрт 10 (шинэ бараа — 3 өдөр)
    await order({ daysAgo: 2, qty: 40 }); // бөөний — хурдад орохгүй
    let x = (await OF.computeReorder(true)).get(prod)!;
    // 500 − 30 − 40 = 430 боломжтой ÷ 10 = 43 хоног
    expect([x.available, x.pace, x.days, x.level, x.basis.fullDays]).toEqual([430, 10, 43, 'OK', 3]);
    expect(await OF.reorderBanner(['SUPER_ADMIN'])).toBeNull();
    await reserve(310); // 120 → 12 хоног
    x = (await OF.computeReorder(true)).get(prod)!;
    expect([x.days, x.level]).toEqual([12, 'ORDER']);
    expect(await OF.reorderBanner(['SUPER_ADMIN'])).toEqual({ urgent: 0, order: 1, late: 0 });
    expect(await OF.reorderBanner(['ADMIN', 'MARKETING_LEAD'])).toBeNull();
    // өнөөдөр 25 гарвал хурд = 25 → 95 ÷ 25 = 3 хоног → 🔴
    for (let i = 0; i < 25; i++) await order({ daysAgo: 0 });
    x = (await OF.computeReorder(true)).get(prod)!;
    expect([x.pace, x.days, x.level]).toEqual([25, 3, 'URGENT']);
    // эрх: зөвхөн СА
    await err(OF.markReordered(adm, { productId: prod, qty: 300 }), 403);
    await err(OF.reorderDetail(mk, prod), 403);
    OF.bustTable();
    expect((await OF.outflowTable(adm, {})).rows.find((r) => r.id === prod)?.reorder).toBeUndefined();
    const t = await OF.outflowTable(sa, { tab: 'reorder' });
    expect([t.rows.map((r) => r.id), t.rows[0]?.reorder?.level, t.counts.reorder]).toEqual([[prod], 'URGENT', 1]);
    // «Захиалсан» — анх ирэх өдөр = өнөөдөр + 15
    const o = await OF.markReordered(sa, { productId: prod, qty: 300 });
    expect(o.expectedDay).toBe(U.ubDay(new Date(), 15));
    await err(OF.markReordered(sa, { productId: prod, qty: 10 }), 409);
    x = (await OF.computeReorder()).get(prod)!;
    expect([x.level, x.order?.qty]).toEqual(['ORDERED', 300]);
    expect(await OF.reorderBanner(['SUPER_ADMIN'])).toBeNull();
    // ирэх өдөр өнгөрсөн → ⏰ хоцорсон
    await db.reorderOrder.update({ where: { id: o.id }, data: { expectedDay: yest } });
    x = (await OF.computeReorder(true)).get(prod)!;
    expect(x.level).toBe('LATE');
    expect(await OF.reorderBanner(['SUPER_ADMIN'])).toEqual({ urgent: 0, order: 0, late: 1 });
    // агуулахад орлого → автоматаар хаагдаж, шинэ үлдэгдлээр
    const wh = await db.warehouse.findFirstOrThrow();
    await D.createReceipt(sa, { warehouseId: wh.id, lines: [{ variantId: v, qty: 300 }], idemKey: randomUUID() });
    x = (await OF.computeReorder(true)).get(prod)!;
    expect([x.available, x.days, x.level, x.order]).toEqual([395, 15, 'ORDER', null]);
    expect((await db.reorderOrder.findUniqueOrThrow({ where: { id: o.id } })).receivedAt).not.toBeNull();
    // андуурсан «Захиалсан»-ыг цуцлах → сануулга буцаж гарна; түүх үлдэнэ
    const o2 = await OF.markReordered(sa, { productId: prod, qty: 50, expectedDay: U.ubDay(new Date(), 10), note: 'Тест' });
    expect((await OF.computeReorder()).get(prod)!.level).toBe('ORDERED');
    await OF.cancelReorder(sa, o2.id);
    expect((await OF.computeReorder()).get(prod)!.level).toBe('ORDER');
    expect((await OF.reorderDetail(sa, prod)).history).toHaveLength(2);
    // #120: нийлүүлэгчийн дэлгүүрт оноовол СА-ын «Бараа татах»-д харагдахгүй (тохиргоо анх асаалттай); унтраавал харагдана
    const SP = await import('@/lib/services/supplier');
    const shop = await SP.saveShop(sa, { name: 'Нийлүүлэгч А' });
    await SP.assignProduct(sa, { shopId: shop.id, productId: prod });
    OF.bustOutflowCache(); OF.bustTable();
    expect((await OF.computeReorder()).get(prod)?.shopId).toBe(shop.id);
    expect(await OF.reorderBanner(['SUPER_ADMIN'])).toBeNull();
    let t2 = await OF.outflowTable(sa, {});
    expect([t2.counts.reorder, t2.rows.find((r) => r.id === prod)?.reorder]).toEqual([0, null]);
    await err(OF.setConfig(lead, { hideSupplierReorder: false }), 403);
    await OF.setConfig(sa, { hideSupplierReorder: false });
    t2 = await OF.outflowTable(sa, {});
    expect([t2.counts.reorder, t2.rows.find((r) => r.id === prod)?.reorder?.level]).toEqual([1, 'ORDER']);
    // үлдэгдэлд хүрэхгүй: журнал = үлдэгдэл
    expect(await db.auditLog.count({ where: { action: { startsWith: 'outflow.reorder' } } })).toBe(3);
    expect(await db.auditLog.count({ where: { action: 'outflow.config' } })).toBe(1);
  });
});

describe('бараа татах — өнгө / хэмжээ тус бүрээр (#128)', () => {
  it('нэг өнгө дуусах дөхвөл барааны мөрөнд тэр өнгө; тэр өнгийг «Захиалсан» болгоход бусад өнгө бодогдсоор; тэр өнгөний орлогоор хаагдана', async () => {
    const p2 = await P.createProduct(sa, { code: 'C9', name: 'Өнгөтэй бараа', price: 10000, colors: ['Улаан', 'Хар'] });
    const [red, black] = p2.variants.map((x) => x.id) as [number, number];
    const wh = await db.warehouse.findFirstOrThrow();
    await D.createReceipt(sa, { warehouseId: wh.id, lines: [{ variantId: red, qty: 10 }, { variantId: black, qty: 200 }], idemKey: randomUUID() });
    const sell = async (variantId: number, daysAgo: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const { order: o } = await O.createOrder(op, { phone: String(99600000 + ++ph), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Тест 5-р байр', pageId: page1, lines: [{ variantId, qty: 1 }], idemKey: randomUUID(), deliveryDate: U.ubDay(new Date(), 1) });
        const at = new Date(U.ubDayStart(U.ubDay(new Date(), -daysAgo)).getTime() + 10 * H);
        await db.order.update({ where: { id: o.id }, data: { createdAt: at, confirmedAt: at } });
      }
    };
    for (let d = 1; d <= 3; d++) { await sell(red, d, 3); await sell(black, d, 3); }
    let x = (await OF.computeReorder(true)).get(p2.id)!;
    // улаан 10 − 9 = 1 ÷ 3 = 0 хоног 🔴; хар 191 ÷ 3 = 63 хоног; нийлбэрээр бол 192 ÷ 6 = 32 (нуугдах байсан)
    expect([x.level, x.days, x.worstLabel]).toEqual(['URGENT', 0, 'Улаан']);
    expect(x.variants.map((v) => [v.label, v.days, v.level])).toEqual([['Улаан', 0, 'URGENT'], ['Хар', 63, 'OK']]);
    // улааныг «Захиалсан» → хар бодогдсоор; хар дуусах дөхвөл барааны мөрөнд «Хар»
    await OF.markReordered(sa, { productId: p2.id, variantId: red, qty: 100 });
    await err(OF.markReordered(sa, { productId: p2.id, variantId: red, qty: 5 }), 409);
    await err(OF.markReordered(sa, { productId: p2.id, qty: 5 }), 409); // өнгөөр захиалсан бол бүхэлд нь тэмдэглэхгүй
    x = (await OF.computeReorder(true)).get(p2.id)!;
    expect([x.level, x.variants[0]!.level, x.variants[1]!.level]).toEqual(['ORDERED', 'ORDERED', 'OK']);
    const { order: big } = await O.createOrder(op, { phone: '99611111', province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Тест', pageId: page1, lines: [{ variantId: black, qty: 160 }], idemKey: randomUUID(), deliveryDate: U.ubDay(new Date(), 1) });
    await db.order.update({ where: { id: big.id }, data: { confirmedAt: new Date(Date.now() - 400 * 86_400_000) } });
    x = (await OF.computeReorder(true)).get(p2.id)!;
    expect([x.level, x.days, x.worstLabel]).toEqual(['ORDER', 10, 'Хар']); // 31 ÷ 3
    // хар өнгийн орлого улааны тэмдгийг хаахгүй; улааны орлого хаана
    await D.createReceipt(sa, { warehouseId: wh.id, lines: [{ variantId: black, qty: 100 }], idemKey: randomUUID() });
    x = (await OF.computeReorder(true)).get(p2.id)!;
    expect(x.variants[0]!.level).toBe('ORDERED');
    await D.createReceipt(sa, { warehouseId: wh.id, lines: [{ variantId: red, qty: 100 }], idemKey: randomUUID() });
    x = (await OF.computeReorder(true)).get(p2.id)!;
    expect([x.variants[0]!.level, x.variants[0]!.order, x.level]).toEqual(['OK', null, 'OK']);
  });
});

describe('гаралтаа хангаагүй пэйж (#121)', () => {
  it('5+ хоног бүүст; пэйж бүрийн 2 өдрийн захиалга < $ → 🔴; 14 хоногт орсон пэйж 0 болсон ч гарна; унтраавал алга', async () => {
    const page3 = (await A.savePage(sa, { name: 'yellowshopy' })).id;
    const page4 = (await A.savePage(sa, { name: 'redshopy' })).id;
    const many = async (pageId: number, daysAgo: number, n: number) => { for (let i = 0; i < n; i++) await order({ pageId, daysAgo }); };
    await many(page1, 2, 2); await many(page1, 1, 3);   // 5 ✅
    await many(page2, 2, 3); await many(page2, 1, 3);   // 6 ✅
    await many(page3, 2, 1); await many(page3, 1, 3);   // 4 🔴
    await many(page4, 10, 2);                           // 0 🔴 (10 хоногийн өмнө орж байсан)
    await order({ pageId: page3, daysAgo: 0, qty: 3 }); // өнөөдрийнх тоологдохгүй
    // 3 хоногийн бүүст — хамаарахгүй
    await boostAt(2, new Date(Date.now() - 3 * 24 * H));
    expect((await OF.pageShortView(mk)).rows).toEqual([]);
    await boostAt(2, new Date(Date.now() - 6 * 24 * H));
    const r = (await OF.pageShortView(mk)).rows;
    expect(r).toHaveLength(1);
    expect(r[0]!.pages.map((x) => [x.name, x.d2, x.d1, x.short])).toEqual([['redshopy', 0, 0, true], ['yellowshopy', 1, 3, true], ['greenshopy', 2, 3, false], ['blackshopy', 3, 3, false]]);
    expect([r[0]!.boostDays, r[0]!.dollar]).toEqual([6, 5]);
    OF.bustTable();
    expect((await OF.outflowTable(adm, {})).counts.pageShort).toBe(1);
    await err(OF.pageShortView(op), 403);
    await OF.saveBoost(mk, { productId: prod, zones: 0 });
    expect((await OF.pageShortView(mk)).rows).toEqual([]);
  });
});

describe('нийлүүлэгчийн мини гарц (#122)', () => {
  it('зөвхөн өөрийн бараа; 7 хоног; авах мөнгө = борлуулалт − суутгал × ш; өөрийн өртөг зөвхөн өөрт; «Захиалсан» өөрийн бараанд л', async () => {
    const SP = await import('@/lib/services/supplier');
    const SO = await import('@/lib/services/supplier-outflow');
    const shop = await SP.saveShop(sa, { name: 'Нийлүүлэгч Б' });
    await SP.assignProduct(sa, { shopId: shop.id, productId: prod });
    await SP.saveDeduction(sa, { shopId: shop.id, productId: prod, operatorCost: 1200, deliveryCost: 5000, marketingCost: 3000, otherCost: 0 });
    const other = await P.createProduct(sa, { code: 'X9', name: 'Миний бараа', price: 9000 });
    const sup = await actor(['SUPPLIER']);
    await db.supplierShop.update({ where: { id: shop.id }, data: { userId: sup.id } });
    for (let d = 1; d <= 3; d++) for (let i = 0; i < 10; i++) await order({ daysAgo: d });
    OF.bustOutflowCache();
    let v1 = await SO.supplierOutflow(sup, null);
    expect(v1.rows.map((r) => r.id)).toEqual([prod]);
    const r = v1.rows[0]!;
    // 30 ш × 20,000 − 30 × 9,200 = 324,000
    expect([r.week, r.daily.slice(1, 4), r.money.perUnitEarn, r.money.earn, r.money.cost, r.reorder?.days]).toEqual([30, [10, 10, 10], 10800, 324000, null, 47]);
    // өөрийн өртөг: зөвхөн нийлүүлэгч; админд харагдахгүй
    await SO.saveOwnCost(sup, { productId: prod, cost: 6000 });
    v1 = await SO.supplierOutflow(sup, null);
    expect([v1.rows[0]!.money.profit, v1.rows[0]!.money.perUnitProfit]).toEqual([324000 - 180000, 4800]);
    const va = await SO.supplierOutflow(adm, shop.id);
    expect([va.isOwner, va.rows[0]!.money.cost, va.rows[0]!.money.profit]).toEqual([false, null, null]);
    await err(SO.saveOwnCost(adm, { productId: prod, cost: 1 }), 403);
    await err(SO.saveOwnCost(sup, { productId: other.id, cost: 1 }), 403);
    // «Захиалсан» — өөрийн бараанд л; бусдын (эзний) бараанд 403
    await err(SO.supplierReorder(sup, null, { productId: other.id, qty: 5 }), 403);
    const o = await SO.supplierReorder(sup, null, { productId: prod, qty: 200 });
    expect((await SO.supplierReorderDetail(sup, null, prod)).info?.level).toBe('ORDERED');
    const mine = await OF.markReordered(sa, { productId: other.id, qty: 1 }).catch(() => null);
    if (mine) await err(SO.supplierReorderCancel(sup, null, mine.id), 403);
    // #124-Ж: таны тэмдэг тусдаа — нийлүүлэгчид харагдахгүй, цуцалж чадахгүй; таных ч нийлүүлэгчийнхийг хөндөхгүй
    const own = await OF.markReordered(sa, { productId: prod, qty: 999, note: 'Нууц тэмдэглэл' });
    expect((await SO.supplierReorderDetail(sup, null, prod)).history.some((h) => h.note === 'Нууц тэмдэглэл')).toBe(false);
    await err(SO.supplierReorderCancel(sup, null, own.id), 403);
    expect((await OF.computeReorder()).get(prod)!.order?.qty).toBe(999);
    await OF.cancelReorder(sa, own.id);
    await SO.supplierReorderCancel(sup, null, o.id);
    // 340-ийг нөөцөлбөл 130 ÷ 10 = 13 хоног → нийлүүлэгчид 🚚 сануулга; СА-д нуугдсан (#120)
    const { order: big } = await O.createOrder(op, { phone: '99488888', province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Тест', pageId: page1, lines: [{ variantId: v, qty: 340 }], idemKey: randomUUID(), deliveryDate: U.ubDay(new Date(), 1) });
    await db.order.update({ where: { id: big.id }, data: { confirmedAt: new Date(Date.now() - 400 * 86_400_000) } });
    OF.bustOutflowCache();
    expect(await SO.supplierReorderBanner(sup)).toEqual({ urgent: 0, order: 1, late: 0 });
    expect((await SO.supplierOutflow(sup, null)).needs).toBe(1);
    expect(await SO.supplierReorderBanner(adm)).toBeNull();
    expect(await OF.reorderBanner(['SUPER_ADMIN'])).toBeNull();
  });
});

describe('бөөний захиалга (#117)', () => {
  it('1 хүн 50 ширхэг: гарцад 50 + 📦, дундаж/өнгөнд орохгүй; опп+хүргэлт нэг л удаа; үр дүн 1 захиалга (💎 биш)', async () => {
    await boostAt(1, U.ubDayStart(yest));
    await order({ daysAgo: 1, qty: 50 });
    await order({ daysAgo: 1 });
    OF.bustTable();
    const r = (await OF.outflowTable(mk, {})).rows.find((x) => x.id === prod)!;
    expect([r.daily[1], r.bulk[1], r.avg]).toEqual([51, { n: 1, qty: 50 }, 0.1]);
    const y = (await OF.profitDetail(sa, prod)).days.find((x) => x.day === yest)!;
    // 51 × 20000 − 51 × 4000 − 2 × 6200 − 18000 = 785,600; захиалгын ашиг 392,800; 2 захиалга < $5 → 💎 биш, 🟢
    expect([y.qty, y.orders, y.oppDelivery, y.profit, y.perUnit, y.status]).toEqual([51, 2, 12400, 785600, 392800, 'GOOD']);
    const ev = await OF.evaluation(lead, yest);
    await OF.setOwner(lead, { productIds: [prod], userId: mk.id });
    expect((await OF.evaluation(lead, yest)).rows.find((x) => x.userId === mk.id)?.items[0]).toMatchObject({ orders: 2, expected: 5, cls: 'POOR' });
    expect(ev.date).toBe(yest);
  });
});

describe('өнгө / хэмжээгээр (догол мөр)', () => {
  it('үндсэн мөр нийлбэр, хувилбар бүрийн гарц ба үлдэгдэл', async () => {
    const p2 = await P.createProduct(sa, { code: 'C2', name: 'Олон өнгөтэй', price: 10000, colors: ['Хар', 'Цагаан'] });
    const [a, b] = p2.variants.map((x) => x.id) as [number, number];
    const wh = await db.warehouse.findFirstOrThrow();
    await D.createReceipt(sa, { warehouseId: wh.id, lines: [{ variantId: a, qty: 10 }, { variantId: b, qty: 10 }], idemKey: randomUUID() });
    for (const [vid, q] of [[a, 2], [b, 1]] as const) {
      const { order } = await O.createOrder(op, { phone: String(99390000 + vid), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Тест 5-р байр', pageId: page1, lines: [{ variantId: vid, qty: q }], idemKey: randomUUID(), deliveryDate: U.ubDay(new Date(), 1) });
      expect(order.id).toBeGreaterThan(0);
    }
    OF.bustTable();
    const row = (await OF.outflowTable(mk, { q: 'Олон өнгөтэй' })).rows[0]!;
    expect([row.daily[0], row.variantCount]).toEqual([3, 2]);
    const v = await OF.productVariants(mk, p2.id);
    expect(v.variants.map((x) => [x.label, x.daily[0], x.available])).toEqual([['Хар', 2, 8], ['Цагаан', 1, 9]]);
  });
});

describe('бүүстийн ашиг ба анхааруулга (#105–#110)', () => {
  it('ширхэгийн ашиг: 5 → 6,200₮ (🟢), 7 → 💎, 2 → 🟠 (< 1,500₮), 1 → 🔴; шинэ бүүст өчигдөр алдагдалтай → 🔴; задаргаа зөвхөн СА', async () => {
    await boostAt(1, U.ubDayStart(yest)); // өчигдөр 00:00-аас 1 бүүст, $5 = 18,000₮/өдөр
    for (let i = 0; i < 5; i++) await order({ daysAgo: 1 });
    let d = await OF.profitDetail(sa, prod);
    const y = d.days.find((x) => x.day === yest)!;
    expect([y.qty, y.boost, y.perUnit, y.status]).toEqual([5, 18000, 6200, 'GOOD']);
    expect([d.marginBeforeBoost, d.breakEven, d.lowProfitAt]).toEqual([9800, 2, 3]);
    await err(OF.profitDetail(adm, prod), 403);
    for (let i = 0; i < 2; i++) await order({ daysAgo: 1 });
    d = await OF.profitDetail(sa, prod);
    expect(d.days.find((x) => x.day === yest)!.status).toBe('DIAMOND');
    const t = await OF.outflowTable(sa, { status: 'DIAMOND' });
    expect(t.rows.map((r) => r.id)).toEqual([prod]);
    expect(t.rows[0]!.profit?.status).toBe('DIAMOND');
    // 2 ширхэг → 🟠
    await db.order.updateMany({ data: { status: 'CANCELLED', cancelledAt: new Date(U.ubDayStart(yest).getTime() + 2 * H) } });
    await order({ daysAgo: 1 }); await order({ daysAgo: 1 });
    expect((await OF.profitDetail(sa, prod)).days.find((x) => x.day === yest)).toMatchObject({ qty: 2, perUnit: 800, status: 'LOW' });
    // 1 ширхэг → 🔴, шинэ бүүст → шууд улаан анхааруулга
    await db.order.updateMany({ where: { status: { not: 'CANCELLED' } }, data: { status: 'CANCELLED', cancelledAt: new Date(U.ubDayStart(yest).getTime() + 3 * H) } });
    await order({ daysAgo: 1, pageId: page1 });
    OF.bustOutflowCache();
    const al = await OF.alertsView(mk);
    expect(al.red.map((a) => a.productId)).toEqual([prod]);
    expect(al.red[0]!.reasons.join(' ')).toContain('шинэ бүүст');
    // Өглөө 08:00-оос хойш өнөөдрийн бүүст (8 цагт 0 захиалга) ч шалгагдаж, пэйж нь өнөөдрийнхөөр (0) — цагаас үл хамааран шалгана
    const intraday = al.red[0]!.reasons.some((r) => r.includes('захиалга алга'));
    expect(al.red[0]!.pages).toEqual(intraday ? [] : [{ name: 'greenshopy', n: 1 }]);
    expect(await OF.alertBanner(['MARKETING'])).toEqual({ red: 1, orange: 0 });
    expect(await OF.alertBanner(['OPERATOR'])).toBeNull();
    // «1 өдөр ажиглах»
    await OF.watchProduct(mk, prod);
    const al2 = await OF.alertsView(mk);
    expect([al2.red.length, al2.watched.length, al2.watched[0]!.watchedBy]).toEqual([0, 1, mk.name]);
    expect(await OF.alertBanner(['MARKETING'])).toBeNull();
    // унтраахад анхааруулга арилна
    await db.boostWatch.deleteMany();
    await OF.saveBoost(mk, { productId: prod, zones: 0 });
    expect((await OF.alertsView(mk)).red).toHaveLength(0);
  });

  it('хэвийн явсан бүүст: өчигдөр л алдагдалтай → 🟠, дараалан 2 өдөр → 🔴; өдрийн дунд: асаасан цагаас 8 цагт 0 → 🔴, 1 → 🟠', async () => {
    await boostAt(1, new Date(U.ubDayStart(U.ubDay(new Date(), -5)).getTime()));
    for (let i = 0; i < 5; i++) await order({ daysAgo: 2 });
    await order({ daysAgo: 1 }); // өчигдөр 1 → алдагдалтай
    let al = await OF.computeAlerts(true);
    // өнөөдөр 00:00-аас 8+ цаг болоогүй бол зөвхөн өчигдрийн дүгнэлт
    const now = Date.now(), todayStart = U.ubDayStart(today).getTime();
    const intraday = now - todayStart >= 8 * H;
    expect(al[0]!.reasons.some((r) => r.includes('Өчигдөр алдагдалтай'))).toBe(true);
    if (!intraday) expect(al[0]!.level).toBe('ORANGE');
    await db.order.updateMany({ where: { confirmedAt: { lt: U.ubDayStart(yest) } }, data: { status: 'CANCELLED', cancelledAt: new Date(U.ubDayStart(U.ubDay(new Date(), -2)).getTime() + H) } });
    await order({ daysAgo: 2 });
    al = await OF.computeAlerts(true);
    expect(al[0]!.level).toBe('RED');
    expect(al[0]!.reasons.join(' ')).toContain('дараалан 2 өдөр');
    // өдрийн дунд: шинэ бүүст 9 цагийн өмнө асаагаад 0 захиалга → 🔴; 1 → 🟠
    await db.order.deleteMany({ where: { confirmedAt: { gte: U.ubDayStart(today) } } });
    await db.productMarketing.update({ where: { productId: prod }, data: { boostOnAt: new Date(now - 9 * H) } });
    if (now - todayStart >= 8 * H) {
      al = await OF.computeAlerts(true);
      expect(al[0]!.reasons.some((r) => r.includes('захиалга алга'))).toBe(true);
      const id = await order({ hour: Math.max(0, (now - todayStart) / H - 1) });
      expect(id).toBeGreaterThan(0);
      al = await OF.computeAlerts(true);
      expect(al[0]!.reasons.some((r) => r.includes('Өсөлтгүй'))).toBe(true);
    }
  });

  it('бүүстийн түүх ба асаах цаг; өдрийн дундуур асаасан бол зардал цагаар; тохиргоо — мөнгө зөвхөн СА', async () => {
    await OF.saveBoost(mk, { productId: prod, zones: 2, dollar: 10 });
    const pm = await db.productMarketing.findUniqueOrThrow({ where: { productId: prod } });
    expect([pm.zones, pm.dollar, !!pm.boostOnAt]).toEqual([2, 10, true]);
    await OF.saveBoost(mk, { productId: prod, zones: 3 });
    expect((await db.productMarketing.findUniqueOrThrow({ where: { productId: prod } })).boostOnAt?.getTime()).toBe(pm.boostOnAt!.getTime());
    expect(await db.boostEvent.count()).toBe(2);
    // өчигдөр 18:00-аас 1 бүүст → өдрийн төсөв бүтнээр (#114: цагаар гүйхгүй)
    await db.boostEvent.deleteMany();
    await db.boostEvent.create({ data: { productId: prod, at: new Date(U.ubDayStart(yest).getTime() + 18 * H), dollar: 5, zones: 1, byName: 'x' } });
    expect((await OF.profitDetail(sa, prod)).days.find((x) => x.day === yest)!.boost).toBe(18000);
    // Аудит А1: цонхны өмнө олон үйл явдал — ХАМГИЙН СҮҮЛИЙН төлөвөөс эхэлнэ (11/01 асаасан → 11/03 унтраасан → цонхонд бүүстгүй)
    await db.boostEvent.deleteMany();
    const d = (n: number) => new Date(U.ubDayStart(U.ubDay(new Date(), -n)).getTime() + 10 * H);
    await db.boostEvent.createMany({ data: [
      { productId: prod, at: d(11), dollar: 5, zones: 1, byName: 'x' },
      { productId: prod, at: d(10), dollar: 5, zones: 3, byName: 'x' },
      { productId: prod, at: d(9), dollar: 5, zones: 0, byName: 'x' },
    ] });
    const days = (await OF.profitDetail(sa, prod)).days;
    expect(days.every((x) => x.boost === 0)).toBe(true);
    // сүүлийн төлөв асаалттай (2 бүс) бол цонхны эхнээс тэр төлөвөөр
    await db.boostEvent.create({ data: { productId: prod, at: d(8), dollar: 5, zones: 2, byName: 'x' } });
    expect((await OF.profitDetail(sa, prod)).days.find((x) => x.day === yest)!.boost).toBe(2 * 18000);
    await err(OF.setConfig(lead, { oppCost: 1 }), 403);
    await OF.setConfig(lead, { claimTarget: 3 });
    await OF.setConfig(sa, { lowProfit: 2000, costPct: 35 });
    expect((await OF.getConfig(db)).claimTarget).toBe(3);
    await err(OF.setConfig(mk, { claimTarget: 1 }), 403);
  });
});

describe('ажлын цонх (#104-4)', () => {
  it('нэг барааг нэг л хүн; N захиалгаар «Хийсэн ✓» (хариуцагч хэвээр); хугацаа дуусвал чөлөөлнө; бусдынхыг ахлах цуцална', async () => {
    await OF.setOwner(lead, { productIds: [prod], userId: mk2.id });
    const c = await OF.claim(mk, prod);
    await err(OF.claim(mk2, prod), 409, 'claimed');
    await err(OF.release(mk2, c.id), 403);
    // Авсан мөчөөс хойшхи захиалга (тестийг өдрийн аль ч цагт ажиллуулахад)
    const nowH = () => (Date.now() + 1000 - U.ubDayStart(U.ubDay()).getTime()) / H;
    const order = (o: Record<string, unknown> = {}) => orderAt({ hour: nowH(), ...o });
    for (let i = 0; i < 4; i++) await order();
    await OF.syncClaims();
    expect((await db.workClaim.findUniqueOrThrow({ where: { id: c.id } })).progress).toBe(4);
    await order();
    await OF.syncClaims();
    expect((await db.workClaim.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('COMPLETED');
    const pm = await db.productMarketing.findUniqueOrThrow({ where: { productId: prod } });
    expect([!!pm.doneAt, pm.doneByName, pm.ownerName]).toEqual([true, mk.name, mk2.name]);
    // хугацаа дуусах
    // #152: зарагдаж буй барааг энгийн маркетинг «ажилд авах»-гүй
    await err(OF.claim(mk2, prod), 400, 'selling');
    await db.order.updateMany({ data: { status: 'CANCELLED', cancelledAt: new Date() } }); // хугацаандаа захиалга аваагүй
    const c2 = await OF.claim(mk2, prod);
    await db.workClaim.update({ where: { id: c2.id }, data: { claimedAt: new Date(Date.now() - 8 * 86_400_000) } });
    await OF.syncClaims();
    expect((await db.workClaim.findUniqueOrThrow({ where: { id: c2.id } })).status).toBe('EXPIRED');
    const c3 = await OF.claim(mk2, prod);
    await OF.release(lead, c3.id);
    expect((await db.workClaim.findUniqueOrThrow({ where: { id: c3.id } })).status).toBe('CANCELLED');
    const ww = await OF.workWindow(mk, { tab: 'all' });
    expect(ww.rows.find((r) => r.id === prod)?.claim).toBeNull();
  });
});

describe('пэйж, статистик, үнэлгээ, цалин (#104-3, 6)', () => {
  it('нэг пэйж — нэг маркетинг; статистик гарцын дүрмээр; үнэлгээ ахлах л (өөрийгөө биш); цалин «Ажилтны цалин»-д автоматаар, давхардахгүй', async () => {
    await OF.setPageOwner(lead, { pageId: page1, userId: mk.id });
    await OF.setPageOwner(lead, { pageId: page1, userId: mk2.id });
    expect((await OF.pageBoard(mk)).pages.find((p) => p.id === page1)?.userId).toBe(mk2.id);
    await err(OF.setPageOwner(mk, { pageId: page2, userId: mk.id }), 403);
    await order(); await order({ status: 'CANCELLED' });
    const st = await OF.stats(lead, today, today);
    expect(st.rows[0]).toMatchObject({ userId: mk2.id, orders: 1, pages: 1, perPage: 1 });
    // үнэлгээ
    await OF.setOwner(lead, { productIds: [prod], userId: mk.id });
    await boostAt(1, U.ubDayStart(yest));
    for (let i = 0; i < 11; i++) await order({ daysAgo: 1 });
    const ev = await OF.evaluation(lead, yest);
    const row = ev.rows.find((r) => r.userId === mk.id)!;
    expect(row.items[0]).toMatchObject({ expected: 5, orders: 11, cls: 'EXCELLENT' });
    await err(OF.saveScore(mk, { userId: mk2.id, date: yest, score: 9, salaryAmount: 1000 }), 403);
    await err(OF.saveScore(lead, { userId: mk.id, date: yest, score: 9 }), 403); // #152: зөвхөн Супер админ
    await OF.saveScore(sa, { userId: mk.id, date: yest, score: 8, salaryAmount: 25000, note: 'Сайн' });
    expect((await OF.scoreHistory(lead, yest, yest)).rows[0]).toMatchObject({ salary: 25000, avgScore: 8 });
    // «Ажилтны цалин»: нэмэлт орлогод автоматаар, хоёр удаа хадгалахад давхардахгүй
    const p = S.periodOf(yest.slice(0, 7), Number(yest.slice(8)) <= 15 ? 1 : 2);
    const prep = await S.prepareSalary(acc, `u:${mk.id}`, p.ym, p.half);
    expect(prep.auto.evalSalary).toBe(25000);
    await S.saveSalary(acc, { staffKey: `u:${mk.id}`, ym: p.ym, half: p.half, baseSalary: 100000, bonusSalary: 0, additions: [{ label: 'Илүү цаг', amount: 5000 }] });
    const rec = await S.saveSalary(acc, { staffKey: `u:${mk.id}`, ym: p.ym, half: p.half, baseSalary: 100000, bonusSalary: 0, additions: [{ label: 'Илүү цаг', amount: 5000 }, { label: S.EVAL_LABEL, amount: 25000 }] });
    expect([rec.totalAdditions, rec.transferSalary]).toEqual([30000, 130000]);
    // Аудит А7: хадгалсны дараа оноо өөрчлөгдвөл түгжихэд «дахин хадгална уу»; дахин хадгалахад шинэ дүнгээр
    await OF.saveScore(sa, { userId: mk.id, date: yest, score: 9, salaryAmount: 45000, note: 'Маш сайн' });
    await err(S.lockSalary(acc, rec.id), 409, 'stale');
    const rec2 = await S.saveSalary(acc, { staffKey: `u:${mk.id}`, ym: p.ym, half: p.half, baseSalary: 100000, bonusSalary: 0, additions: [{ label: 'Илүү цаг', amount: 5000 }] });
    expect(rec2.totalAdditions).toBe(50000);
    expect((await S.lockSalary(acc, rec2.id)).record.isLocked).toBe(true);
    // #152: цоожтой хугацааны үнэлгээг өөрчлөхгүй
    await err(OF.saveScore(sa, { userId: mk.id, date: yest, score: 1, salaryAmount: 0 }), 409, 'salary_locked');
    const dd = await OF.dailyDetail(lead, yest);
    expect(dd.rows.find((r) => r.userId === mk.id)?.items[0]?.daily[0]).toBe(11);
  });
});
