import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** #219 (эзэн): «Төлбөр хүлээж буй» — захиалгын «Өнөөдөр», барааны гарцын «Өнөөдөр»-т мөнгө орсны дараа л тоологдоно */
let db: typeof import('@/lib/db').db;
let P: typeof import('@/lib/services/products');
let W: typeof import('@/lib/services/stock/warehouses');
let D: typeof import('@/lib/services/stock/docs');
let O: typeof import('@/lib/services/orders/orders');
let Q: typeof import('@/lib/services/orders/queries');
let A: typeof import('@/lib/services/orders/admin');
let OF: typeof import('@/lib/services/outflow');
let U: typeof import('@/lib/ubdate');
beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  P = await import('@/lib/services/products'); W = await import('@/lib/services/stock/warehouses'); D = await import('@/lib/services/stock/docs');
  O = await import('@/lib/services/orders/orders'); Q = await import('@/lib/services/orders/queries'); A = await import('@/lib/services/orders/admin');
  OF = await import('@/lib/services/outflow'); U = await import('@/lib/ubdate');
});
let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(74900000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
let sa: UserActor, op: UserActor, page1: number, v1: number, prod: number;
beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); op = await actor(['OPERATOR']);
  page1 = (await A.savePage(sa, { name: 'Шоп' })).id;
  const p = await P.createProduct(sa, { code: 'G1', name: 'Бараа', price: 50000 });
  prod = p.id; v1 = p.variants[0]!.id;
  const wh = await W.createWarehouse(sa, { name: 'Төв агуулах' });
  await D.createReceipt(sa, { warehouseId: wh.id, lines: [{ variantId: v1, qty: 50 }], idemKey: randomUUID() });
});
const ub = (phone: string, over: Record<string, unknown> = {}) => ({ phone, province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Нарны 45', pageId: page1, lines: [{ variantId: v1, qty: 2 }], idemKey: randomUUID(), ...over });

describe('#219 төлбөр хүлээж буй — мөнгө орсны дараа л тоологдоно', () => {
  it('захиалгын «Өнөөдөр» таб, тоо; барааны гарцын өнөөдөр', async () => {
    const paid = (await O.createOrder(op, ub('99112233'))).order;
    const pend = (await O.createOrder(op, ub('99112244', { prepaidWait: true }))).order;
    expect(pend.status).toBe('PENDING_PAYMENT');
    const l = await Q.listOrders(op, { tab: 'today' });
    expect(l.items.map((x) => x.id)).toEqual([paid.id]);
    expect((await Q.tabCounts()).today).toBe(1);
    const t = U.ubDay();
    const qty = async () => (await OF.unitsByDay(t, t, [prod])).reduce((s, r) => s + r.qty, 0);
    expect(await qty()).toBe(2);
    // нэг удаа баталгаажаад «Төлбөр хүлээж буй» руу буцсан ч тоологдохгүй
    await db.order.update({ where: { id: pend.id }, data: { confirmedAt: new Date() } });
    expect(await qty()).toBe(2);
    // мөнгө орсны дараа (Шинэ) тоологдоно
    await db.order.update({ where: { id: pend.id }, data: { status: 'NEW' } });
    expect(await qty()).toBe(4);
  });
});
