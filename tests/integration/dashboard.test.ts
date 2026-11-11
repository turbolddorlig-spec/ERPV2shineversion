import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** Хянах самбар (#123): захиалгын өдрөөр, нийт = бүх бодит захиалга, хойшлуулсан = цуцлагдсан, хувь ÷ нийт, чиг хандлага = картууд */
let db: typeof import('@/lib/db').db;
let DB: typeof import('@/lib/services/dashboard');
let P: typeof import('@/lib/services/products');
let W: typeof import('@/lib/services/stock/warehouses');
let D: typeof import('@/lib/services/stock/docs');
let O: typeof import('@/lib/services/orders/orders');
let A: typeof import('@/lib/services/orders/admin');
let U: typeof import('@/lib/ubdate');
beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  DB = await import('@/lib/services/dashboard');
  P = await import('@/lib/services/products'); W = await import('@/lib/services/stock/warehouses'); D = await import('@/lib/services/stock/docs');
  O = await import('@/lib/services/orders/orders'); A = await import('@/lib/services/orders/admin'); U = await import('@/lib/ubdate');
});
let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(78000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
const H = 3_600_000;
let sa: UserActor; let adm: UserActor; let op: UserActor; let drv: UserActor; let page: number; let v: number; let ph = 0;
async function order(data: Record<string, unknown>, at = new Date(U.ubDayStart(U.ubDay()).getTime() + 2 * H)) {
  const { order: o } = await O.createOrder(op, { phone: String(99500000 + ++ph), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 1, addressDetail: 'Тест', pageId: page, lines: [{ variantId: v, qty: 1 }], idemKey: randomUUID(), deliveryDate: U.ubDay(new Date(), 1) });
  await db.order.update({ where: { id: o.id }, data: { confirmedAt: at, createdAt: at, ...data } });
}
beforeEach(async () => {
  await resetDb(db as never);
  DB.bustDashboard();
  sa = await actor(['SUPER_ADMIN']); adm = await actor(['ADMIN']); op = await actor(['OPERATOR']); drv = await actor(['DRIVER']);
  page = (await A.savePage(sa, { name: 'greenshopy' })).id;
  const p = await P.createProduct(sa, { code: 'D1', name: 'Самбарын бараа', price: 10000 });
  v = p.variants[0]!.id;
  const wh = (await W.createWarehouse(sa, { name: 'Төв' })).id;
  await D.createReceipt(sa, { warehouseId: wh, lines: [{ variantId: v, qty: 100 }], idemKey: randomUUID() });
});

describe('Хянах самбар (#123)', () => {
  it('нийт = бүх бодит; хүргэсэн/цуцлагдсан/хүргэлтэд; хойшлуулсан → цуцлагдсан; хувь ÷ нийт; төлбөр хүлээж буй орохгүй; 00:00 UB хил', async () => {
    for (let i = 0; i < 6; i++) await order({ status: 'DELIVERED' });
    await order({ status: 'CANCELLED', cancelReason: 'NO_ANSWER' });
    await order({ status: 'CANCELLED', cancelReason: 'NO_ANSWER' });
    await order({ status: 'NEW', postponedByDriverId: drv.id, postponedAt: new Date() }); // хойшлуулсан → цуцлагдсан
    await order({ status: 'OUT_FOR_DELIVERY', driverId: drv.id });
    await order({ status: 'PENDING_PAYMENT', confirmedAt: null });                       // орохгүй
    // UB 00:30 = өнөөдөр; UB өчигдөр 23:30 = өчигдөр
    await order({ status: 'DELIVERED' }, new Date(U.ubDayStart(U.ubDay()).getTime() + 0.5 * H));
    await order({ status: 'DELIVERED' }, new Date(U.ubDayStart(U.ubDay()).getTime() - 0.5 * H));
    const s = await DB.summary(adm, 'day', undefined);
    expect(s.kpi).toEqual({ total: 11, delivered: 7, cancelled: 3, inDelivery: 1, waiting: 0, postponed: 1, successRate: 63.6, cancelRate: 27.3 });
    expect(s.reasons.map((r) => [r.key, r.n])).toEqual([['NO_ANSWER', 2], ['POSTPONED', 1]]);
    expect(s.reasons[1]!.label).toBe('Жолооч хойшлуулсан');
    expect(s.cancelledProducts[0]).toMatchObject({ name: 'Самбарын бараа', orders: 3, qty: 3 });
    // 7 хоног: чиг хандлагын нийлбэр = картууд; өчигдрийн 23:30-ийнх өчигдөрт
    const w = await DB.summary(adm, 'week', undefined);
    expect(w.trend).toHaveLength(7);
    expect(w.trend.at(-1)).toMatchObject({ date: U.ubDay(), total: 11, delivered: 7, cancelled: 3 });
    expect(w.trend.at(-2)).toMatchObject({ date: U.ubDay(new Date(), -1), total: 1, delivered: 1 });
    expect([w.kpi.total, w.kpi.delivered]).toEqual([12, 8]);
    expect(w.trend.reduce((a, d) => a + d.total, 0)).toBe(w.kpi.total);
    // хойшлуулсан захиалга дахин хүргэгдвэл Хүргэсэн
    await db.order.updateMany({ where: { postponedByDriverId: drv.id }, data: { status: 'DELIVERED' } });
    DB.bustDashboard();
    expect((await DB.summary(adm, 'day', undefined)).kpi).toMatchObject({ delivered: 8, cancelled: 2, postponed: 0 });
  });

  it('эрх: СА, Админ л; анхаарах зүйлс эрхээр (бараа татах зөвхөн СА); буруу огноо', async () => {
    await expect(DB.summary(op, 'day', undefined)).rejects.toBeInstanceOf(AppError);
    await expect(DB.summary(sa, 'day', '2026-13-40')).rejects.toBeInstanceOf(AppError);
    const a = await DB.attention(adm);
    expect(a.items.find((x) => x.key === 'reorder')).toBeUndefined();
    expect(Array.isArray((await DB.attention(sa)).items)).toBe(true);
  });
});
