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


/** Аудит #152 — барааны гарц: үнэлгээ зөвхөн СА, хариуцагчид тоолох, 🔴 СА-д үргэлж, $ бууруулсан, ажиглах нэг удаа, огноо */
describe('#152 барааны гарц', () => {
  it('үнэлгээг зөвхөн Супер админ тавина (ахлах маркетинг, админ — үгүй)', async () => {
    await err(OF.saveScore(lead, { userId: mk.id, date: yest, score: 9, salaryAmount: 100_000_000 }), 403);
    await err(OF.saveScore(adm, { userId: mk.id, date: yest, score: 9, salaryAmount: 1000 }), 403);
    await OF.saveScore(sa, { userId: mk.id, date: yest, score: 9, salaryAmount: 20000 });
    expect((await OF.evaluation(lead, yest)).canScore).toBe(false);
    expect((await OF.evaluation(sa, yest)).canScore).toBe(true);
  });

  it('үнэлгээнд бараа хариуцагчид л тоологдоно — бусдын барааны дугаар засварлаад өөртөө тооцуулахгүй', async () => {
    await OF.setOwner(lead, { productIds: [prod], userId: mk.id });
    await boostAt(2, U.ubDayStart(yest));
    for (let i = 0; i < 12; i++) await order({ daysAgo: 1 });
    // mk2 өчигдөр зөвхөн AD дугаарыг өөрчилсөн
    await db.boostEvent.create({ data: { productId: prod, at: new Date(U.ubDayStart(yest).getTime() + 3600_000 * 5), dollar: 5, zones: 2, adNumber: 77, byId: mk2.id, byName: mk2.name } });
    const ev = await OF.evaluation(sa, yest);
    expect(ev.rows.find((r) => r.userId === mk.id)!.orderCount).toBe(12);
    expect(ev.rows.find((r) => r.userId === mk2.id)!.orderCount).toBe(0);
  });

  it('🔴 Супер админд «ажиглаж буй» байсан ч харагдана; нэг анхааруулгад нэг л удаа ажиглана', async () => {
    await boostAt(1, new Date(Date.now() - 10 * H));
    await OF.computeAlerts(true);
    const before = await OF.alertBanner(['SUPER_ADMIN']);
    expect(before?.red ?? 0).toBeGreaterThan(0);
    await OF.watchProduct(mk, prod);
    await err(OF.watchProduct(mk2, prod), 409, 'watched');
    await OF.computeAlerts(true);
    expect((await OF.alertBanner(['SUPER_ADMIN']))?.red).toBe(before!.red);
    expect((await OF.alertBanner(['MARKETING']))?.red ?? 0).toBe(before!.red - 1);
  });

  it('асаалттай бүүстийн $-ыг багасгавал анхааруулга гарна', async () => {
    await OF.saveBoost(mk, { productId: prod, zones: 1, dollar: 20 });
    await db.boostEvent.updateMany({ data: { at: new Date(Date.now() - 50 * H) } });
    await OF.saveBoost(mk, { productId: prod, dollar: 1 });
    const al = (await OF.computeAlerts(true)).find((a) => a.productId === prod);
    expect(al?.reasons.join(' ')).toContain('$ багасгасан: $20 → $1');
  });

  it('байхгүй огноо, хол «Захиалсан» өдөр, зэрэг «Захиалсан» — алдаагүй', async () => {
    expect(U.isYmd('2026-02-31')).toBe(false);
    expect(U.isYmd('2024-02-29')).toBe(true);
    await err(OF.saveScore(sa, { userId: mk.id, date: '2026-02-31', score: 5, salaryAmount: 0 }), 400);
    await err(OF.markReordered(sa, { productId: prod, qty: 10, expectedDay: '2099-12-31' }), 400, 'bad_date');
    const rs = await Promise.allSettled([1, 2, 3, 4, 5].map(() => OF.markReordered(sa, { productId: prod, qty: 10 })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of rs) if (r.status === 'rejected') expect((r.reason as AppError).status).toBe(409);
  });

  it('олон бараанд хариуцагч нэг дор (5,000 хүртэл) — хурдан', async () => {
    const ids = [prod];
    const t0 = Date.now();
    await OF.setOwner(lead, { productIds: ids, userId: mk2.id });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((await db.productMarketing.findUniqueOrThrow({ where: { productId: prod } })).ownerName).toBe(mk2.name);
  });
});
