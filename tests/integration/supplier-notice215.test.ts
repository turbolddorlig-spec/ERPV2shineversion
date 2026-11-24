import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** #215 — нийлүүлэгчид мэдэгдэл: нэг дэлгүүрт эсвэл бүгдэд, устгатал харагдана, «Уншсан»; хил хаалт нийлүүлэгчид ч */
let db: typeof import('@/lib/db').db;
let N: typeof import('@/lib/services/supplier-notice');
let B: typeof import('@/lib/services/border');
beforeAll(async () => { db = (await import('@/lib/db')).db; N = await import('@/lib/services/supplier-notice'); B = await import('@/lib/services/border'); });
let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(74800000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
beforeEach(async () => { await resetDb(db as never); });

describe('#215 нийлүүлэгчид мэдэгдэл', () => {
  it('нэг дэлгүүрт / бүгдэд; зөвхөн хамаарах нийлүүлэгчид; уншсан ч харагдана; устгавал алга; эрх', async () => {
    const sa = await actor(['SUPER_ADMIN']); const s1 = await actor(['SUPPLIER']); const s2 = await actor(['SUPPLIER']);
    const a = await db.supplierShop.create({ data: { name: 'Дэлгүүр А', userId: s1.id } });
    await db.supplierShop.create({ data: { name: 'Дэлгүүр Б', userId: s2.id } });
    await expect(N.createNotice(await actor(['OPERATOR']), { shopId: 'all', text: 'Сайн байна уу' })).rejects.toMatchObject({ status: 403 });
    await expect(N.createNotice(sa, { shopId: 'all', text: '' })).rejects.toMatchObject({ status: 400 });
    const one = await N.createNotice(sa, { shopId: a.id, text: 'Танай барааны үнэ өөрчлөгдлөө' });
    await N.createNotice(await actor(['ADMIN']), { shopId: 'all', text: 'Цагаан сарын хил хаалтаас өмнө бараагаа нөөцлөөрэй' });
    expect((await N.myNotices(s1))?.map((x) => x.text)).toEqual(['Цагаан сарын хил хаалтаас өмнө бараагаа нөөцлөөрэй', 'Танай барааны үнэ өөрчлөгдлөө']);
    expect((await N.myNotices(s2))?.map((x) => x.text)).toEqual(['Цагаан сарын хил хаалтаас өмнө бараагаа нөөцлөөрэй']);
    expect(await N.myNotices(sa)).toBeNull();
    // Б нийлүүлэгч А-гийн мэдэгдлийг «уншсан» болгохгүй
    await expect(N.markRead(s2, one.id)).rejects.toMatchObject({ status: 404 });
    await N.markRead(s1, one.id); await N.markRead(s1, one.id);
    expect((await N.myNotices(s1))?.find((x) => x.id === one.id)?.read).toBe(true);
    const l = await N.listNotices(sa);
    expect(l.items.find((x) => x.id === one.id)).toMatchObject({ shopName: 'Дэлгүүр А', readCount: 1, target: 1 });
    expect(l.items.find((x) => x.shopId === null)).toMatchObject({ readCount: 0, target: 2 });
    await N.deleteNotice(sa, one.id);
    expect((await N.myNotices(s1))?.map((x) => x.id)).not.toContain(one.id);
    expect(await db.auditLog.count({ where: { action: { in: ['supplier.notice_created', 'supplier.notice_deleted'] } } })).toBe(3);
  });

  it('хил хаалтын мэдэгдэл нийлүүлэгчид ч харагдана', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    await B.setBorder(sa, { items: [{ name: 'Цагаан сар', from: '2027-02-06', to: '2027-02-12' }] });
    expect(await B.borderAlert(['SUPPLIER'], '2027-01-10')).not.toBeNull();
  });
});
