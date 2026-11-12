import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/**
 * Туршилтын оруулалт (#138): хуучин ERP-ийн нэг жолоочийн 24 захиалга (хувийн мэдээллийг сольсон хуулбар) —
 * 16 хүргэсэн (355,000₮), 3 цуцалсан, 5 маргааш. Жинхэнэ урсгалаар орж, тооцоо, үлдэгдэл яг таарна.
 */
let db: typeof import('@/lib/db').db;
let LI: typeof import('@/lib/services/legacy-import');
let W: typeof import('@/lib/services/stock/warehouses');
let V: typeof import('@/lib/services/stock/views');
let U: typeof import('@/lib/ubdate');

const TEXT = readFileSync(new URL('../fixtures/legacy-sample.txt', import.meta.url), 'utf8');
let sa: UserActor; let op: UserActor;
let seq = 0;
async function actor(roles: Role[], name?: string): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(77000000 + seq), name: name ?? `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
async function err(p: Promise<unknown>, status: number, code?: string) {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(status);
    if (code) expect((e as AppError).code).toBe(code);
    return;
  }
  throw new Error(`Алдаа гарах ёстой байсан (${status})`);
}

beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  LI = await import('@/lib/services/legacy-import');
  W = await import('@/lib/services/stock/warehouses');
  V = await import('@/lib/services/stock/views');
  U = await import('@/lib/ubdate');
});

beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']);
  op = await actor(['OPERATOR'], 'Опп2');
  await W.createWarehouse(sa, { name: 'Төв агуулах' });
});

describe('туршилтын оруулалт — хуучин ERP-ийн жолоочийн жагсаалт', () => {
  it('уншина: 24 захиалга, 16 хүргэсэн / 3 цуцалсан / 5 маргааш', () => {
    const { orders, declared } = LI.parseLegacy(TEXT);
    expect(declared).toBe(24);
    expect(orders).toHaveLength(24);
    expect(orders.every((o) => o.errors.length === 0)).toBe(true);
    expect(orders.filter((o) => o.action === 'DELIVER')).toHaveLength(16);
    expect(orders.filter((o) => o.action === 'CANCEL')).toHaveLength(3);
    expect(orders.filter((o) => o.action === 'POSTPONE')).toHaveLength(5);
    const two = orders.find((o) => o.number === '00166641')!;
    expect(two.lines).toEqual([{ code: 'Gshopy0120bb', name: 'Наадаг савхи бор', qty: 2, price: 20000 }]);
    expect(orders.find((o) => o.number === '00166857')!.note).toBe('шалгаж явуулах');
    expect(LI.legacyAddress('Баянгол, 6 бичил 16-р байр')).toEqual({ province: 'Улаанбаатар', district: 'Баянгол', addressDetail: '6 бичил 16-р байр' });
  });

  it('зөвхөн Супер админ; алдаатай бол батлахгүй', async () => {
    await err(LI.legacyPreview(op, { text: TEXT, driverName: 'Батаа', driverPhone: '88112233' }), 403);
    const bad = await LI.legacyPreview(sa, { text: TEXT, driverName: '', driverPhone: '12' });
    expect(bad.ok).toBe(false);
    await err(LI.legacyCommit(sa, { text: TEXT, driverName: '', driverPhone: '12' }), 400, 'has_errors');
    expect(await db.order.count()).toBe(0);
  });

  it('нэг товчоор: бараа + орлого → жолооч → захиалга → падаан → хүргэсэн/цуцалсан/маргааш; тооцоо яг таарна', async () => {
    const pv = await LI.legacyPreview(sa, { text: TEXT, driverName: 'Батаа', driverPhone: '88112233' });
    expect(pv.general).toEqual([]);
    expect(pv.ok).toBe(true);
    expect(pv.summary).toMatchObject({ total: 24, deliver: 16, deliverSum: 355000, cash: 355000, cancel: 3, postpone: 5, salary: 80000 });
    expect(pv.products).toHaveLength(19);
    expect(pv.opps.find((o) => o.name === 'Опп2')?.suggestId).toBe(op.id); // нэрээр олдсон

    const r = await LI.legacyCommit(sa, { text: TEXT, driverName: 'Батаа', driverPhone: '88112233' });
    expect(r.tempPassword).toBeTruthy();
    const day = r.day;
    expect(day.delivered).toBe(16);
    expect(day.deliveredAmount).toBe(355000);
    expect(day.cash).toBe(355000);
    expect(day.cancelled).toBe(3);
    expect(day.postponed).toBe(5);
    expect(day.rate).toBe(5000);
    expect(day.salary).toBe(80000);
    expect(day.toReceive).toBe(355000 - 80000);

    // захиалгууд: оператор, тэмдэглэл, төлөв
    const orders = await db.order.findMany({ where: { idemKey: { startsWith: 'legacy-' } } });
    expect(orders).toHaveLength(24);
    expect(orders.filter((o) => o.status === 'DELIVERED')).toHaveLength(16);
    expect(orders.filter((o) => o.status === 'CANCELLED')).toHaveLength(3);
    const post = orders.filter((o) => o.status === 'NEW');
    expect(post).toHaveLength(5);
    expect(post.every((o) => U.ymdOf(o.deliveryDate) === U.ubDay(new Date(), 1) && o.postponedAt)).toBe(true);
    expect(orders.filter((o) => o.operatorId === op.id)).toHaveLength(pv.opps.find((o) => o.name === 'Опп2')!.count);
    expect(orders.find((o) => o.idemKey === 'legacy-00167223')!.note).toContain('Хуучин №00167223');
    expect(orders.every((o) => o.deliveryFee === 0)).toBe(true);

    // бараа: цуцалсан + маргааш 8 ширхэг жолооч дээр, агуулахад үлдэгдэл 0, журнал = үлдэгдэл
    const drvLoc = await db.stockLocation.findUniqueOrThrow({ where: { kind_userId: { kind: 'DRIVER', userId: r.driver.id } } });
    const onDriver = await db.stockBalance.aggregate({ where: { locationId: drvLoc.id }, _sum: { qty: true } });
    expect(onDriver._sum.qty).toBe(8);
    const rec = await V.reconcile(sa, { fresh: true });
    expect(rec.ok).toBe(true);
    expect(await db.stockBalance.count({ where: { qty: { lt: 0 } } })).toBe(0);

    // давтан дарахад шинээр юу ч үүсэхгүй
    const again = await LI.legacyPreview(sa, { text: TEXT, driverName: 'Батаа', driverPhone: '88112233' });
    expect(again.summary.new).toBe(0);
    const r2 = await LI.legacyCommit(sa, { text: TEXT, driverName: 'Батаа', driverPhone: '88112233' });
    expect(r2.day.delivered).toBe(16);
    expect(await db.order.count()).toBe(24);
    expect(await db.product.count()).toBe(19);
    expect((await V.reconcile(sa, { fresh: true })).ok).toBe(true);
  });

  it('V2-д идэвхтэй захиалгатай утас → алдаа; өөр жолоочид өмнө орсон → алдаа', async () => {
    await LI.legacyCommit(sa, { text: TEXT, driverName: 'Батаа', driverPhone: '88112233' });
    const other = await LI.legacyPreview(sa, { text: TEXT, driverName: 'Цэцгээ', driverPhone: '88112244' });
    expect(other.ok).toBe(false);
    expect(other.rows.some((x) => x.errors.some((e) => e.includes('өөр жолоочид')))).toBe(true);
  });

  it('V2-д байгаа бараа: үнэ өндөр бол хуучин үнээр хөнгөлөлттэй, бага бол алдаа; идэвхтэй захиалгатай утас алдаа', async () => {
    const P = await import('@/lib/services/products');
    const O = await import('@/lib/services/orders/orders');
    await P.createProduct(sa, { code: 'Uch0329', name: 'Усаар буддаг ном', price: 25000 });
    await P.createProduct(sa, { code: 'Gshopy0291', name: 'Утасгүй цэнэглэгч', price: 20000 });
    const pv = await LI.legacyPreview(sa, { text: TEXT, driverName: 'Батаа', driverPhone: '88112233' });
    expect(pv.products.find((p) => p.code === 'UCH0329')).toMatchObject({ isNew: false, listPrice: 25000, errors: [] });
    expect(pv.products.find((p) => p.code === 'GSHOPY0291')!.errors[0]).toContain('бага');
    expect(pv.ok).toBe(false);
    // идэвхтэй захиалга
    const D = await import('@/lib/services/stock/docs');
    const v = (await db.productVariant.findFirstOrThrow({ where: { code: 'UCH0329' } })).id;
    const wid = (await db.warehouse.findFirstOrThrow()).id;
    await D.createReceipt(sa, { warehouseId: wid, lines: [{ variantId: v, qty: 5 }], idemKey: 'legacy-test-receipt-1' });
    await O.createOrder(op, { phone: '88800003', province: 'Улаанбаатар', district: 'Баянгол', addressDetail: 'Тест байр', lines: [{ variantId: v, qty: 1 }], idemKey: 'legacy-test-order-2' });
    const pv2 = await LI.legacyPreview(sa, { text: TEXT, driverName: 'Батаа', driverPhone: '88112233' });
    expect(pv2.rows.find((r) => r.phone === '88800003')!.errors.some((e) => e.includes('идэвхтэй захиалга'))).toBe(true);
  });
});
