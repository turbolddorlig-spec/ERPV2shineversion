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
async function order(over: { daysAgo?: number; hour?: number; status?: 'NEW' | 'CANCELLED'; cancelDaysAgo?: number; qty?: number; pageId?: number } = {}) {
  const { order } = await O.createOrder(op, { phone: String(99300000 + ++ph), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Тест 5-р байр',
    pageId: over.pageId ?? page1, lines: [{ variantId: v, qty: over.qty ?? 1 }], idemKey: randomUUID(), deliveryDate: U.ubDay(new Date(), 1) });
  const at = new Date(U.ubDayStart(U.ubDay(new Date(), -(over.daysAgo ?? 0))).getTime() + (over.hour ?? 10) * H);
  const data: Record<string, unknown> = { createdAt: at, confirmedAt: at };
  if (over.status === 'CANCELLED') Object.assign(data, { status: 'CANCELLED', cancelledAt: new Date(U.ubDayStart(U.ubDay(new Date(), -(over.cancelDaysAgo ?? over.daysAgo ?? 0))).getTime() + 20 * H) });
  await db.order.update({ where: { id: order.id }, data });
  return order.id;
}
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
    expect(al.red[0]!.pages).toEqual([{ name: 'greenshopy', n: 1 }]);
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
    for (let i = 0; i < 4; i++) await order();
    await OF.syncClaims();
    expect((await db.workClaim.findUniqueOrThrow({ where: { id: c.id } })).progress).toBe(4);
    await order();
    await OF.syncClaims();
    expect((await db.workClaim.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('COMPLETED');
    const pm = await db.productMarketing.findUniqueOrThrow({ where: { productId: prod } });
    expect([!!pm.doneAt, pm.doneByName, pm.ownerName]).toEqual([true, mk.name, mk2.name]);
    // хугацаа дуусах
    const c2 = await OF.claim(mk2, prod);
    await db.order.updateMany({ data: { status: 'CANCELLED', cancelledAt: new Date() } }); // хугацаандаа захиалга аваагүй
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
    await err(OF.saveScore(lead, { userId: lead.id, date: yest, score: 9 }), 403);
    await OF.saveScore(lead, { userId: mk.id, date: yest, score: 8, salaryAmount: 25000, note: 'Сайн' });
    expect((await OF.scoreHistory(lead, yest, yest)).rows[0]).toMatchObject({ salary: 25000, avgScore: 8 });
    // «Ажилтны цалин»: нэмэлт орлогод автоматаар, хоёр удаа хадгалахад давхардахгүй
    const p = S.periodOf(yest.slice(0, 7), Number(yest.slice(8)) <= 15 ? 1 : 2);
    const prep = await S.prepareSalary(acc, `u:${mk.id}`, p.ym, p.half);
    expect(prep.auto.evalSalary).toBe(25000);
    await S.saveSalary(acc, { staffKey: `u:${mk.id}`, ym: p.ym, half: p.half, baseSalary: 100000, bonusSalary: 0, additions: [{ label: 'Илүү цаг', amount: 5000 }] });
    const rec = await S.saveSalary(acc, { staffKey: `u:${mk.id}`, ym: p.ym, half: p.half, baseSalary: 100000, bonusSalary: 0, additions: [{ label: 'Илүү цаг', amount: 5000 }, { label: S.EVAL_LABEL, amount: 25000 }] });
    expect([rec.totalAdditions, rec.transferSalary]).toEqual([30000, 130000]);
    const dd = await OF.dailyDetail(lead, yest);
    expect(dd.rows.find((r) => r.userId === mk.id)?.items[0]?.daily[0]).toBe(11);
  });
});
