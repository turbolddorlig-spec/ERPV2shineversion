import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

let db: typeof import('@/lib/db').db;
let I: typeof import('@/lib/services/orders/idle');
beforeAll(async () => {
  db = (await import('@/lib/db')).db;
  I = await import('@/lib/services/orders/idle');
});
let seq = 0;
async function actor(roles: Role[], name?: string): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(77100000 + seq), name: name ?? `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
async function err(p: Promise<unknown>, status: number) {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AppError); expect((e as AppError).status).toBe(status); return; }
  throw new Error('Алдаа гарах ёстой байсан');
}
/** «order.created» түүх — N минутын өмнө */
async function created(a: UserActor, minutesAgo: number[]) {
  await db.auditLog.createMany({ data: minutesAgo.map((m) => ({ action: 'order.created', entityType: 'Order', entityId: String(1000 + ++seq), actorId: a.id, actorName: a.name, at: new Date(Date.now() - m * 60_000), details: {} })) });
}
/** Бодит цаг УБ 02:00-оос өмнө бол «N минутын өмнө» өчигдөр болно */
const nearMidnight = () => new Date(Date.now() + 8 * 3600_000).getUTCHours() < 2;
beforeEach(async () => { await resetDb(db as never); process.env.TEST_UB_MINUTE = String(15 * 60); }); // 15:00
afterEach(() => { delete process.env.TEST_UB_MINUTE; });

describe('#202 операторын идэвхгүй байдлын сануулга', () => {
  it('өнөөдөр 10+ захиалга, сүүлийн 15 минутад ≤ 2 → сануулна; идэвхтэй, цөөн захиалгатай, оператор бус → үгүй; СА, ахлахад л', async () => {
    const sa = await actor(['SUPER_ADMIN']); const lead = await actor(['OPERATOR_LEAD']); const opr = await actor(['OPERATOR']);
    const anujin = await actor(['OPERATOR'], 'Анужин');
    const busy = await actor(['OPERATOR'], 'Идэвхтэй');
    const few = await actor(['OPERATOR'], 'Шинэ ажилтан');
    // 15:00 — өнөөдөр 12 (өглөө), сүүлийн 15 минутад 0
    const mins = (n: number, from: number) => Array.from({ length: n }, (_, i) => from + i * 5);
    if (nearMidnight()) return; // «N минутын өмнө» өчигдөр болох тул алгасна
    await created(anujin, mins(12, 30).filter((m) => m < 14 * 60));
    await created(busy, [...mins(10, 30), 2, 5, 8]);        // сүүлийн 15 минутад 3 → болно
    await created(few, [100, 120]);                          // өнөөдөр 2 → «ажиллаж байна» биш
    await created(sa, mins(12, 30));                         // оператор биш
    const v = await I.idleOperators();
    expect(v.map((x) => [x.name, x.inWindow])).toEqual([['Анужин', 0]]);
    expect((await I.idleOperatorsAlert(['SUPER_ADMIN']))?.length).toBe(1);
    expect((await I.idleOperatorsAlert(['OPERATOR_LEAD']))?.length).toBe(1);
    expect(await I.idleOperatorsAlert(['OPERATOR'])).toBeNull();
    expect(await I.idleOperatorsAlert(['ADMIN'])).toBeNull();
    // 2 захиалга үүсгэвэл (≤ 2) сануулсан хэвээр; 3 болвол алга
    await created(anujin, [1, 3]);
    expect((await I.idleOperators()).map((x) => [x.name, x.inWindow])).toEqual([['Анужин', 2]]);
    await created(anujin, [4]);
    expect(await I.idleOperators()).toEqual([]);
    void lead; void opr;
  });

  it('цайны цаг, ажлын цагаас гадуур, ажил эхэлснээс 15 минут болоогүй, унтраасан → сануулахгүй; тохиргоо', async () => {
    if (nearMidnight()) return;
    const sa = await actor(['SUPER_ADMIN']); const anujin = await actor(['OPERATOR'], 'Анужин');
    await created(anujin, Array.from({ length: 12 }, (_, i) => 30 + i * 5));
    const at = async (hhmm: number) => { process.env.TEST_UB_MINUTE = String(hhmm); return (await I.idleOperators()).length; };
    expect(await at(12 * 60 + 30)).toBe(0);  // цайны цаг
    expect(await at(13 * 60 + 5)).toBe(0);   // цайнаас гараад 15 минут болоогүй (цонх цайтай давхцана)
    expect(await at(13 * 60 + 20)).toBe(1);
    expect(await at(9 * 60 + 40)).toBe(0);   // 09:30 эхэлснээс 15 минут болоогүй
    expect(await at(21 * 60 + 30)).toBe(0);  // ажлын цагаас гадуур
    // Тохиргоо: 30 минут, ≤ 0
    await err(I.setIdleConfig(await actor(['OPERATOR_LEAD']), { windowMin: 30 }), 403);
    await err(I.setIdleConfig(sa, { start: '9:3' }), 400);
    await err(I.setIdleConfig(sa, { lunchFrom: '08:00' }), 400);
    expect(await I.setIdleConfig(sa, { windowMin: 30, maxInWindow: 0 })).toMatchObject({ windowMin: 30, maxInWindow: 0, start: '09:30' });
    expect(await at(15 * 60)).toBe(1);
    await I.setIdleConfig(sa, { enabled: false });
    expect(await at(15 * 60)).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'settings.operator_idle' } })).toBe(2);
  });
});
