import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** Модуль 7а — Алдаа удирдлага (#90): гараар торгууль, алдааны нэр үүсгэх, цуцлах, хасах, миний торгууль, асуудлаас автомат торгууль */
let db: typeof import('@/lib/db').db;
let PN: typeof import('@/lib/services/penalties');
let P: typeof import('@/lib/services/products');
let W: typeof import('@/lib/services/stock/warehouses');
let D: typeof import('@/lib/services/stock/docs');
let O: typeof import('@/lib/services/orders/orders');
let A: typeof import('@/lib/services/orders/admin');
let L: typeof import('@/lib/services/delivery/assign');
let H: typeof import('@/lib/services/delivery/handover');
let DR: typeof import('@/lib/services/delivery/driver');
let U: typeof import('@/lib/ubdate');

beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  PN = await import('@/lib/services/penalties');
  P = await import('@/lib/services/products');
  W = await import('@/lib/services/stock/warehouses');
  D = await import('@/lib/services/stock/docs');
  O = await import('@/lib/services/orders/orders');
  A = await import('@/lib/services/orders/admin');
  L = await import('@/lib/services/delivery/assign');
  H = await import('@/lib/services/delivery/handover');
  DR = await import('@/lib/services/delivery/driver');
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
let sa: UserActor; let adm: UserActor; let acc: UserActor; let pen: UserActor; let olead: UserActor; let op: UserActor; let mk: UserActor; let wh: UserActor; let lead: UserActor; let drv: UserActor;
beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); adm = await actor(['ADMIN']); acc = await actor(['ACCOUNTING']); pen = await actor(['PENALTY_OFFICER']); olead = await actor(['OPERATOR_LEAD']);
  op = await actor(['OPERATOR']); mk = await actor(['MARKETING']); wh = await actor(['WAREHOUSE']); lead = await actor(['DRIVER_LEAD']); drv = await actor(['DRIVER']);
});

describe('гараар торгууль', () => {
  it('#124-Е1: хэсэгчлэн суутгасан торгуулийг бүхэлд нь цуцлахгүй — зөвхөн үлдэгдлийг', async () => {
    const p = await PN.createPenalty(pen, { userId: op.id, customName: 'Хоцролт', amount: 5000 });
    await db.penalty.update({ where: { id: p.id }, data: { deductedAmount: 2000 } }); // цалингаар 2,000₮ суутгагдсан мэт
    const r = await PN.cancelPenalty(adm, p.id, { note: 'Үлдэгдлийг уучлав' });
    const row = await db.penalty.findUniqueOrThrow({ where: { id: p.id } });
    expect([row.status, row.amount, row.deductedAmount, row.deducted]).toEqual(['ACTIVE', 2000, 2000, true]);
    expect(r.duplicate).toBe(false);
    expect(await db.auditLog.count({ where: { action: 'penalty.remaining_cancelled' } })).toBe(1);
  });

  it('алдааны нэрийг шинээр үүсгэнэ; торгууль тавих; эрх; цуцлах (устгахгүй); цалингаас хасах; миний торгууль зөвхөн өөрийнх', async () => {
    const cfg = await PN.penaltyConfig(pen);
    expect(cfg.categories.filter((c) => c.type === 'OPP_ERROR').map((c) => c.name)).toEqual(['Коммент шүүгээгүй', 'Чат шүүгээгүй', 'Дугаар үлдээсэн', 'Шэйр хийгээгүй', '3 удаа залгаагүй']);
    await err(PN.saveCategory(op, { type: 'OPP_ERROR', name: 'Хоцролт', defaultAmount: 3000 }), 403);
    const c = await PN.saveCategory(pen, { type: 'OPP_ERROR', name: 'Хоцролт', defaultAmount: 3000, lateMinutes: true });
    await err(PN.saveCategory(pen, { type: 'OPP_ERROR', name: 'хоцролт', defaultAmount: 3000 }), 409, 'duplicate');
    await err(PN.createPenalty(op, { userId: op.id, categoryId: c.id, amount: 3000 }), 403);
    await err(PN.createPenalty(pen, { userId: op.id, amount: 3000 }), 400, 'category_required');
    const p1 = await PN.createPenalty(pen, { userId: op.id, categoryId: c.id, amount: 3000, lateMinutes: 15 });
    expect([p1.type, p1.category, p1.amount, p1.createdByName]).toEqual(['OPP_ERROR', 'Хоцролт (15 мин)', 3000, pen.name]);
    // #150: ахлах оператор зөвхөн операторт; ролд тохирохгүй төрөл, өөртөө — хориотой
    await err(PN.createPenalty(olead, { userId: mk.id, customName: 'Зураг буруу оруулсан', amount: 10000 }), 403);
    await err(PN.createPenalty(pen, { userId: op.id, type: 'WAREHOUSE_ERROR', customName: 'Агуулах', amount: 1000 }), 400, 'type_mismatch');
    await err(PN.createPenalty(pen, { userId: pen.id, customName: 'Өөртөө', amount: 1 }), 403);
    await err(PN.createPenalty(pen, { userId: sa.id, customName: 'Супер', amount: 1000 }), 400, 'bad_target');
    await err(PN.createPenalty(pen, { userId: op.id, customName: 'Их дүн', amount: 1_000_001 }), 400);
    const p2 = await PN.createPenalty(pen, { userId: mk.id, customName: 'Зураг буруу оруулсан', amount: 10000 });
    expect(p2.type).toBe('MARKETING_ERROR');
    const p3 = await PN.createPenalty(pen, { userId: op.id, customName: 'Бусад', amount: 2000 });
    // Нуусан нэрийг сонгохгүй
    await PN.saveCategory(pen, { id: c.id, name: 'Хоцролт', defaultAmount: 3000, active: false });
    await err(PN.createPenalty(pen, { userId: op.id, categoryId: c.id, amount: 3000 }), 400);
    // Хасах — нягтлан, админ
    await err(PN.setDeducted(pen, p1.id), 403);
    await PN.setDeducted(acc, p1.id);
    expect((await PN.setDeducted(acc, p1.id)).duplicate).toBe(true);
    await err(PN.cancelPenalty(adm, p1.id, { note: 'буруу тавьсан' }), 409, 'deducted');
    await err(PN.cancelPenalty(adm, p3.id, { note: '' }), 400, 'reason_required');
    await PN.cancelPenalty(adm, p3.id, { note: 'Буруу хүнд тавьсан' });
    // Аудит Б21: зөвхөн Супер админ, Админ цуцална
    await err(PN.cancelPenalty(pen, p1.id, { note: 'Торгуулийн ажилтан' }), 403);
    await err(PN.cancelPenalty(olead, p1.id, { note: 'Ахлах оператор' }), 403);
    expect(await db.penalty.count()).toBe(3); // устгаагүй
    const l = await PN.listPenalties(acc, {});
    expect([l.summary.total, l.summary.pending, l.summary.deducted, l.summary.cancelled, l.summary.byType.OPP_ERROR.amount]).toEqual([13000, 10000, 3000, 1, 3000]);
    expect((await PN.listPenalties(acc, { status: 'PENDING' })).items.map((x) => x.id)).toEqual([p2.id]);
    await err(PN.listPenalties(op, {}), 403);
    const mine = await PN.myPenalties(op, {});
    expect(mine.items.map((x) => x.id).sort()).toEqual([p1.id, p3.id].sort());
    expect([mine.summary.total, mine.summary.deducted]).toEqual([3000, 3000]);
    expect((await PN.myPenalties(drv, {})).items).toHaveLength(0);
    // Огноо Улаанбаатарын цагаар
    expect((await PN.listPenalties(acc, { from: U.ubDay(), to: U.ubDay() })).total).toBe(3);
    expect((await PN.listPenalties(acc, { to: U.ubDay(new Date(), -1) })).total).toBe(0);
    // Автомат дүн — зөвхөн тохиргооны эрхтэй
    await err(PN.setAutoAmounts(pen, { OPP_ERROR: 7000 }), 403);
    expect(await PN.setAutoAmounts(adm, { OPP_ERROR: 7000 })).toMatchObject({ OPP_ERROR: 7000, MARKETING_ERROR: 5000 });
    // Ажилчдын мэдээлэл
    const info = await PN.employeeInfo(acc, op.id);
    expect([info.summary.total, info.recent.length, info.loanTotal]).toEqual([3000, 2, 0]);
  });
});

describe('асуудлаас автомат торгууль (хуучин шиг)', () => {
  it('Опп → захиалга авсан ажилтан, Маркетинг → маркетинг ажилтан, Агуулах → падаан бэлдсэн, Жолооч → торгуульгүй; дүн тохиргооноос; давхардахгүй', async () => {
    const page = (await A.savePage(sa, { name: 'Шоп' })).id;
    const prod = await P.createProduct(sa, { code: 'X1', name: 'Бараа', price: 10000 });
    const v = prod.variants[0]!.id;
    const whId = (await W.createWarehouse(sa, { name: 'Төв' })).id;
    await D.createReceipt(wh, { warehouseId: whId, lines: [{ variantId: v, qty: 50 }], idemKey: randomUUID() });
    await H.setTrusted(acc, { driverId: drv.id, trusted: true });
    await PN.setAutoAmounts(adm, { OPP_ERROR: 6000 });
    const today = U.ubDay();
    let n = 0;
    const mkOrder = async (by: UserActor) => (await O.createOrder(by, { phone: String(99300000 + ++n), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 1, addressDetail: 'Тест', pageId: page, deliveryDate: today, lines: [{ variantId: v, qty: 1 }], idemKey: randomUUID() })).order.id;
    const ids = [await mkOrder(op), await mkOrder(op), await mkOrder(op), await mkOrder(op)];
    await L.assignOrders(lead, { ids, driverId: drv.id });
    const h = await H.createHandover(wh, { driverId: drv.id, date: today, orderIds: ids });
    await H.prepareHandover(wh, h.id);
    for (const it of (await H.handoverDetail(wh, h.id)).items) await H.setCheck(wh, h.id, { variantId: it.variantId, checked: true });
    await H.confirmHandover(wh, h.id);
    await H.setDriverCheck(drv, h.id, { variantId: 'all', checked: true }); await H.receiveHandover(drv, h.id);
    const faults = ['OPERATOR', 'MARKETING', 'WAREHOUSE', 'DRIVER'] as const;
    const warn: (string | null)[] = [];
    for (const [i, f] of faults.entries()) {
      await DR.reportIssue(drv, ids[i]!, { type: 'WRONG_NUMBER' });
      warn.push((await DR.resolveIssue(olead, ids[i]!, { action: 'cancel', note: 'Тест шийдвэр', fault: f })).penaltyWarning ?? null);
    }
    const ps = await db.penalty.findMany({ orderBy: { id: 'asc' } });
    expect(ps.map((p) => [p.type, p.userId, p.amount, p.auto, p.category])).toEqual([
      ['OPP_ERROR', op.id, 6000, true, 'Дугаар буруу'],
      ['WAREHOUSE_ERROR', wh.id, 5000, true, 'Дугаар буруу (Агуулах)'],
    ]);
    // Маркетингийн алдаа: захиалгыг оператор авсан тул хариуцагч олдсонгүй (хуучин шиг анхааруулга)
    expect(warn[0]).toBe(null);
    expect(warn[1]).toMatch(/хариуцагч олдсонгүй/);
    expect(warn[3]).toBe(null);
    // Маркетинг ажилтны (захиалга авах эрхтэй, олон ролтой) авсан захиалга → түүнд
    const mkop = await actor(['OPERATOR', 'MARKETING']);
    const mid = await mkOrder(mkop);
    await L.assignOrders(lead, { ids: [mid], driverId: drv.id });
    const nh = await db.order.findUniqueOrThrow({ where: { id: mid } });
    const h2 = await H.createHandover(wh, { driverId: drv.id, date: U.ymdOf(nh.deliveryDate), orderIds: [mid] });
    await H.prepareHandover(wh, h2.id);
    for (const it of (await H.handoverDetail(wh, h2.id)).items) await H.setCheck(wh, h2.id, { variantId: it.variantId, checked: true });
    await H.confirmHandover(wh, h2.id); await H.setDriverCheck(drv, h2.id, { variantId: 'all', checked: true }); await H.receiveHandover(drv, h2.id);
    await DR.reportIssue(drv, mid, { type: 'WRONG_PRODUCT' });
    await DR.resolveIssue(olead, mid, { action: 'cancel', note: 'Маркетинг буруу', fault: 'MARKETING' });
    // #150: оператор + маркетинг хүний цалингаас хасагдах төрөл — опп-ын алдаа
    const mp = await db.penalty.findFirstOrThrow({ where: { userId: mkop.id, auto: true } });
    expect(mp.type).toBe('OPP_ERROR');
    expect([mp.userId, mp.amount, mp.orderNumber, mp.category]).toEqual([mkop.id, 5000, nh.number, 'Бараа буруу']);
    expect((await PN.myPenalties(mkop, {})).summary.total).toBe(5000);
  });
});
