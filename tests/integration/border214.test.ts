import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** #214 — Замын-Үүдийн хил хаагдах өдрүүд: Тохиргоонд гараар, эхлэхээс 1 сарын өмнөөс хатуу мэдэгдэл */
let db: typeof import('@/lib/db').db;
let B: typeof import('@/lib/services/border');
beforeAll(async () => { db = (await import('@/lib/db')).db; B = await import('@/lib/services/border'); });
let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(74700000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
beforeEach(async () => { await resetDb(db as never); });

describe('#214 хил хаалт', () => {
  it('Цагаан сар 2027/2/6-аас 7 хоног: 1 сарын өмнө 1/6-наас мэдэгдэнэ, 1/5-нд үгүй; хаалтын үеэр «хаалттай»; дууссаны дараа алга', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    await expect(B.setBorder(await actor(['ADMIN']), { items: [] })).rejects.toMatchObject({ status: 403 });
    await expect(B.setBorder(sa, { items: [{ name: 'Цагаан сар', from: '2027-02-12', to: '2027-02-06' }] })).rejects.toMatchObject({ status: 400 });
    await expect(B.setBorder(sa, { items: [{ name: '', from: '2027-02-06', to: '2027-02-12' }] })).rejects.toMatchObject({ status: 400 });
    await B.setBorder(sa, { items: [{ name: 'Цагаан сар', from: '2027-02-06', to: '2027-02-12' }] });
    expect(await B.borderAlert(['SUPER_ADMIN'], '2027-01-05')).toBeNull();
    expect(await B.borderAlert(['SUPER_ADMIN'], '2027-01-06')).toEqual([{ name: 'Цагаан сар', from: '2027-02-06', to: '2027-02-12', days: 7, daysLeft: 31, closed: false }]);
    expect((await B.borderAlert(['PURCHASER'], '2027-02-05'))?.[0]?.daysLeft).toBe(1);
    expect(await B.borderAlert(['OPERATOR'], '2027-02-05')).toBeNull();
    expect((await B.borderAlert(['SUPER_ADMIN'], '2027-02-08'))?.[0]?.closed).toBe(true);
    expect(await B.borderAlert(['SUPER_ADMIN'], '2027-02-13')).toBeNull();
    // сарыг өөрчилж болно (2 сар → 12/6-наас)
    await B.setBorder(sa, { warnMonths: 2 });
    expect((await B.getBorder()).items).toHaveLength(1);
    expect(await B.borderAlert(['SUPER_ADMIN'], '2026-12-06')).not.toBeNull();
    expect(await B.borderAlert(['SUPER_ADMIN'], '2026-12-05')).toBeNull();
    expect([B.minusMonths('2027-03-31', 1), B.minusMonths('2027-01-15', 1)]).toEqual(['2027-02-28', '2026-12-15']);
    expect(await db.auditLog.count({ where: { action: 'settings.border' } })).toBe(2);
  });
});
