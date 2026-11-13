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
let sa: UserActor; let sa2: UserActor; let adm: UserActor; let acc: UserActor; let pen: UserActor; let olead: UserActor; let op: UserActor; let mk: UserActor;
beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); sa2 = await actor(['SUPER_ADMIN']); adm = await actor(['ADMIN']); acc = await actor(['ACCOUNTING']); pen = await actor(['PENALTY_OFFICER']); olead = await actor(['OPERATOR_LEAD']);
  op = await actor(['OPERATOR']); mk = await actor(['MARKETING']);
});

/** Аудит #150 — торгууль: өөрийнхөө, тохирох төрөл, хэнд, хязгаар, цоожлох мөчийн цуцлалт, давхар дарах, «Хаяг тодорхойгүй» */
describe('#150 торгууль', () => {
  it('өөрийнхөө торгуулийг цуцлах, «Цалингаас хассан» болгох, өөртөө тавих боломжгүй; өөр хүн хийнэ', async () => {
    const pa = await PN.createPenalty(pen, { userId: acc.id, type: 'OPP_ERROR', customName: 'Тайлан хоцорсон', amount: 50000 });
    await err(PN.setDeducted(acc, pa.id), 403);
    const pd = await PN.createPenalty(pen, { userId: adm.id, type: 'OPP_ERROR', customName: 'Хоцролт', amount: 20000 });
    await err(PN.cancelPenalty(adm, pd.id, { note: 'Өөрийнхөө торгууль' }), 403);
    await PN.cancelPenalty(sa, pd.id, { note: 'Супер админ цуцлав' });
    const ps = await PN.createPenalty(pen, { userId: adm.id, type: 'OPP_ERROR', customName: 'Хоцролт 2', amount: 5000 });
    await PN.setDeducted(acc, ps.id);
    const au = await db.auditLog.findFirstOrThrow({ where: { action: 'penalty.deducted' } });
    expect(JSON.stringify(au.details)).toContain(adm.name);
    await err(PN.createPenalty(pen, { userId: pen.id, customName: 'Өөртөө', amount: 1 }), 403);
    void sa2;
  });

  it('ролд тохирох төрөл л; Супер админ, нийлүүлэгч, идэвхгүй хүнд үгүй; ахлах оператор — операторт л; 1,000,000₮ хүртэл; давхар дарахад нэг', async () => {
    await err(PN.createPenalty(pen, { userId: op.id, type: 'WAREHOUSE_ERROR', customName: 'Агуулах', amount: 50000 }), 400, 'type_mismatch');
    await err(PN.createPenalty(pen, { userId: sa.id, customName: 'x', amount: 5000 }), 400, 'bad_target');
    await db.user.update({ where: { id: mk.id }, data: { isActive: false } });
    await err(PN.createPenalty(pen, { userId: mk.id, customName: 'x', amount: 5000 }), 400, 'bad_target');
    await err(PN.createPenalty(olead, { userId: adm.id, customName: 'x', amount: 5000 }), 403);
    await err(PN.createPenalty(pen, { userId: op.id, customName: 'Их', amount: 10_000_000 }), 400);
    const [a, b] = await Promise.all([1, 2].map(() => PN.createPenalty(pen, { userId: op.id, customName: 'Коммент шүүгээгүй', amount: 5000 })));
    expect(a.id).toBe(b.id);
    expect(await db.penalty.count({ where: { userId: op.id } })).toBe(1);
    const l = await PN.listPenalties(acc, {});
    expect(l.staff.find((s) => s.id === op.id)?.fixedType).toBe('OPP_ERROR');
    await err(PN.listPenalties(acc, { from: '2020-01-01', to: U.ubDay() }), 400, 'range_too_long');
    expect((await PN.listPenalties(acc, { page: 999999 })).page).toBe(500);
  });

  it('цалин цоожлох мөчид цуцлах: хэсэгчлэн хасагдсан бол бүхэлд нь цуцлагдахгүй (мөнгө алдагдахгүй)', async () => {
    const p = await PN.createPenalty(pen, { userId: op.id, customName: 'Хоцролт', amount: 10000 });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(9::int4, hashtext(${'u:' + op.id}))`;
      await tx.$executeRaw`UPDATE "Penalty" SET "deductedAmount" = "deductedAmount" + 3000 WHERE id = ${p.id}`;
      await held;
    }, { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 200));
    const c = PN.cancelPenalty(adm, p.id, { note: 'Буруу тавьсан' });
    await new Promise((r) => setTimeout(r, 300));
    release(); await holder;
    await c;
    const row = await db.penalty.findUniqueOrThrow({ where: { id: p.id } });
    expect([row.status, row.deductedAmount, row.amount]).toEqual(['ACTIVE', 3000, 3000]); // зөвхөн үлдэгдэл цуцлагдав
  });

  it('гараар «Хаяг тодорхойгүй» гэж бичсэн ч цалингаас хасагдана (зөвхөн автомат ангилал хасагдахгүй)', async () => {
    expect(PN.isUnclearAddressAuto({ auto: false, category: 'Хаяг тодорхойгүй' })).toBe(false);
    expect(PN.isUnclearAddressAuto({ auto: true, category: 'Хаяг тодорхойгүй' })).toBe(true);
    expect(PN.salaryPenaltyType(['OPERATOR', 'MARKETING'])).toBe('OPP_ERROR');
    expect(PN.salaryPenaltyType(['ACCOUNTING'])).toBe(null);
  });
});
