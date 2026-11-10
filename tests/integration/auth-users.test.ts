import { beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import { db } from '@/lib/db';
import { hashPassword } from '@/lib/password';
import { resolveSession } from '@/lib/session';
import { AppError } from '@/lib/errors';
import { changeOwnPassword, login, logoutEverywhere } from '@/lib/services/auth';
import {
  activateUser, createUser, deactivateUser, listUsers, resetPassword, unlockUser, updateUser, userHistory, type UserActor,
} from '@/lib/services/users';

const PW = 'Secret123';
let seq = 0;
const meta = { ip: '127.0.0.1', userAgent: 'vitest' };

async function mk(roles: Role[], extra: { isActive?: boolean } = {}) {
  seq++;
  const phone = String(70000000 + seq);
  const u = await db.user.create({ data: { phone, name: `Тест ${roles.join('+')} ${seq}`, roles, passwordHash: await hashPassword(PW), ...extra } });
  const actor: UserActor = { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
  return { ...u, actor };
}

async function expectErr(p: Promise<unknown>, status: number, code?: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(status);
    if (code) expect((e as AppError).code).toBe(code);
    return e as AppError;
  }
  throw new Error(`Алдаа гарах ёстой байсан (${status})`);
}

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "Session", "User" CASCADE');
});

describe('нэвтрэх', () => {
  it('зөв нууц үгээр нэвтэрч, сесс хүчинтэй', async () => {
    const u = await mk(['OPERATOR']);
    const r = await login(u.phone, PW, meta);
    const s = await resolveSession(r.token);
    expect(s?.user.id).toBe(u.id);
  });
  it('зураастай утсаар ч нэвтэрнэ', async () => {
    const u = await mk(['OPERATOR']);
    const r = await login(`${u.phone.slice(0, 4)}-${u.phone.slice(4)}`, PW, meta);
    expect(r.token).toBeTruthy();
  });
  it('буруу нууц үг ба байхгүй утас — ижил мессеж', async () => {
    const u = await mk(['OPERATOR']);
    const a = await expectErr(login(u.phone, 'wrong-pass', meta), 401, 'invalid_credentials');
    const b = await expectErr(login('99999999', 'wrong-pass', meta), 401, 'invalid_credentials');
    expect(a.message).toBe(b.message);
  });
  it('идэвхгүй хэрэглэгч нэвтэрч чадахгүй', async () => {
    const u = await mk(['OPERATOR'], { isActive: false });
    await expectErr(login(u.phone, PW, meta), 401);
  });
  it('5 буруу → түгжинэ, зөв нууц үг ч ажиллахгүй, админ тайлна', async () => {
    const admin = await mk(['ADMIN']);
    const u = await mk(['OPERATOR']);
    for (let i = 0; i < 4; i++) await expectErr(login(u.phone, 'bad-pass', meta), 401);
    await expectErr(login(u.phone, 'bad-pass', meta), 423, 'locked');
    await expectErr(login(u.phone, PW, meta), 423, 'locked');
    const lead = await mk(['OPERATOR_LEAD']);
    await expectErr(unlockUser(lead.actor, u.id), 403);
    await unlockUser(admin.actor, u.id);
    const r = await login(u.phone, PW, meta);
    expect(r.token).toBeTruthy();
    const logs = await db.auditLog.findMany({ where: { entityId: u.id, action: { in: ['auth.locked', 'user.unlocked'] } } });
    expect(logs.map((l) => l.action).sort()).toEqual(['auth.locked', 'user.unlocked']);
  });
  it('15 минут өнгөрсний дараа түгжээ өөрөө тайлагдана', async () => {
    const u = await mk(['OPERATOR']);
    await db.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect((await login(u.phone, PW, meta)).token).toBeTruthy();
  });
  it('зэрэг 10 буруу оролдлого — тоо алдагдахгүй, түгжигдэнэ', async () => {
    const u = await mk(['OPERATOR']);
    await Promise.allSettled(Array.from({ length: 10 }, () => login(u.phone, 'bad-pass', meta)));
    const fresh = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(fresh.lockedUntil && fresh.lockedUntil.getTime() > Date.now()).toBe(true);
  });
});

describe('сесс', () => {
  it('хугацаа дууссан сесс хүчингүй', async () => {
    const u = await mk(['OPERATOR']);
    const r = await login(u.phone, PW, meta);
    await db.session.updateMany({ where: { userId: u.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await resolveSession(r.token)).toBeNull();
  });
  it('ашиглахад 30 хоногоор сунгагдана', async () => {
    const u = await mk(['OPERATOR']);
    const r = await login(u.phone, PW, meta);
    const soon = new Date(Date.now() + 60_000);
    await db.session.updateMany({ where: { userId: u.id }, data: { lastSeenAt: new Date(Date.now() - 2 * 3600_000), expiresAt: soon } });
    await resolveSession(r.token);
    const s = await db.session.findFirstOrThrow({ where: { userId: u.id } });
    expect(s.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600_000);
  });
  it('хуурамч токен хүчингүй', async () => {
    expect(await resolveSession('x'.repeat(43))).toBeNull();
    expect(await resolveSession('')).toBeNull();
  });
  it('бүх төхөөрөмжөөс гарах', async () => {
    const u = await mk(['OPERATOR']);
    const a = await login(u.phone, PW, meta);
    const b = await login(u.phone, PW, meta);
    await logoutEverywhere(u.actor);
    expect(await resolveSession(a.token)).toBeNull();
    expect(await resolveSession(b.token)).toBeNull();
  });
});

describe('нууц үг', () => {
  it('өөрийн нууц үг солиход бусад төхөөрөмж гарна, одоогийнх үлдэнэ', async () => {
    const u = await mk(['OPERATOR']);
    const phoneA = await login(u.phone, PW, meta);
    const phoneB = await login(u.phone, PW, meta);
    const sA = await resolveSession(phoneA.token);
    await expectErr(changeOwnPassword(u.actor, sA!.sessionId, 'wrong', 'NewPass1'), 400, 'wrong_password');
    await expectErr(changeOwnPassword(u.actor, sA!.sessionId, PW, '123'), 400, 'weak_password');
    await changeOwnPassword(u.actor, sA!.sessionId, PW, 'NewPass1');
    expect(await resolveSession(phoneA.token)).not.toBeNull();
    expect(await resolveSession(phoneB.token)).toBeNull();
    await expectErr(login(u.phone, PW, meta), 401);
    expect((await login(u.phone, 'NewPass1', meta)).token).toBeTruthy();
  });
  it('ахлагч сэргээвэл түр нууц үг, солих ёстой, хуучин нэвтрэлт хаагдана', async () => {
    const lead = await mk(['DRIVER_LEAD']);
    const d = await mk(['DRIVER']);
    const old = await login(d.phone, PW, meta);
    const { temporaryPassword } = await resetPassword(lead.actor, d.id);
    expect(await resolveSession(old.token)).toBeNull();
    await expectErr(login(d.phone, PW, meta), 401);
    const r = await login(d.phone, temporaryPassword, meta);
    expect(r.user.mustChangePassword).toBe(true);
  });
});

describe('хэрэглэгчийн удирдлага', () => {
  it('ахлах оператор зөвхөн оператор үүсгэнэ', async () => {
    const lead = await mk(['OPERATOR_LEAD']);
    const r = await createUser(lead.actor, { phone: '9911-2233', name: 'Ану', roles: ['OPERATOR'] });
    expect(r.user.roles).toEqual(['OPERATOR']);
    expect(r.temporaryPassword).toMatch(/^.{8}$/);
    expect(JSON.stringify(r.user)).not.toMatch(/passwordHash/);
    await expectErr(createUser(lead.actor, { phone: '99112234', name: 'Админ', roles: ['ADMIN'] }), 403);
    await expectErr(createUser(lead.actor, { phone: '99112235', name: 'Холимог', roles: ['OPERATOR', 'WAREHOUSE'] }), 403);
  });
  it('ахлагч өөр багийн хүнийг засаж, хааж чадахгүй', async () => {
    const lead = await mk(['OPERATOR_LEAD']);
    const driver = await mk(['DRIVER']);
    await expectErr(updateUser(lead.actor, driver.id, { name: 'Өөрчлөх' }), 403);
    await expectErr(deactivateUser(lead.actor, driver.id), 403);
    await expectErr(resetPassword(lead.actor, driver.id), 403);
    await expectErr(userHistory(lead.actor, driver.id), 403);
  });
  it('ахлагч өөрийн багийн хүний эрхийг хааж, нээнэ; хаахад шууд гарна', async () => {
    const lead = await mk(['MARKETING_LEAD']);
    const m = await mk(['MARKETING']);
    const s = await login(m.phone, PW, meta);
    await deactivateUser(lead.actor, m.id);
    expect(await resolveSession(s.token)).toBeNull();
    await expectErr(login(m.phone, PW, meta), 401);
    await activateUser(lead.actor, m.id);
    expect((await login(m.phone, PW, meta)).token).toBeTruthy();
  });
  it('олон role-тэй хүнийг (Маркетинг+Агуулах) ахлах маркетинг удирдахгүй — админ л', async () => {
    const lead = await mk(['MARKETING_LEAD']);
    const admin = await mk(['ADMIN']);
    const both = await mk(['MARKETING', 'WAREHOUSE']);
    await expectErr(deactivateUser(lead.actor, both.id), 403);
    const r = await updateUser(admin.actor, both.id, { roles: ['MARKETING', 'WAREHOUSE', 'DRIVER_LEAD'] });
    expect(r.roles).toEqual(['DRIVER_LEAD', 'WAREHOUSE', 'MARKETING']);
  });
  it('ахлагчийн жагсаалтад зөвхөн өөрийн баг харагдана', async () => {
    const lead = await mk(['DRIVER_LEAD']);
    await mk(['DRIVER']); await mk(['DRIVER']); await mk(['OPERATOR']); await mk(['DRIVER', 'WAREHOUSE']);
    const r = await listUsers(lead.actor, { status: 'all' });
    expect(r.total).toBe(2);
    expect(r.items.every((i) => i.roles.length === 1 && i.roles[0] === 'DRIVER')).toBe(true);
  });
  it('админ супер админд хүрч чадахгүй', async () => {
    const sa = await mk(['SUPER_ADMIN']);
    const admin = await mk(['ADMIN']);
    await expectErr(updateUser(admin.actor, sa.id, { name: 'X' }), 403);
    await expectErr(deactivateUser(admin.actor, sa.id), 403);
    await expectErr(createUser(admin.actor, { phone: '99001100', name: 'Шинэ СА', roles: ['SUPER_ADMIN'] }), 403);
  });
  it('өөрийгөө хааж, өөрийн role-ийг өөрчилж болохгүй', async () => {
    const sa = await mk(['SUPER_ADMIN']);
    await expectErr(deactivateUser(sa.actor, sa.id), 400);
    await expectErr(updateUser(sa.actor, sa.id, { roles: ['ADMIN'] }), 403);
  });
  it('буруу өгөгдөл', async () => {
    const admin = await mk(['ADMIN']);
    await expectErr(createUser(admin.actor, { phone: '123', name: 'Ану', roles: ['OPERATOR'] }), 400);
    await expectErr(createUser(admin.actor, { phone: '99112233', name: 'А', roles: ['OPERATOR'] }), 400);
    await expectErr(createUser(admin.actor, { phone: '99112233', name: 'Ану', roles: [] }), 400);
    await expectErr(createUser(admin.actor, { phone: '99112233', name: 'Ану', roles: ['HACKER'] }), 400);
    await expectErr(createUser(admin.actor, { phone: '99112233', name: 'Ану', roles: ['OPERATOR'], password: '12' }), 400, 'weak_password');
    await expectErr(createUser(admin.actor, { phone: '99112233', name: 'Ану', roles: 'OPERATOR' }), 400);
  });
  it('давхар утас → 409; зэрэг 5 хүсэлт → яг 1 үүснэ', async () => {
    const admin = await mk(['ADMIN']);
    await createUser(admin.actor, { phone: '88001122', name: 'Нэг', roles: ['OPERATOR'] });
    await expectErr(createUser(admin.actor, { phone: '8800-1122', name: 'Хоёр', roles: ['OPERATOR'] }), 409, 'phone_taken');
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => createUser(admin.actor, { phone: '88003344', name: `Зэрэг ${i}`, roles: ['DRIVER'] })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.user.count({ where: { phone: '88003344' } })).toBe(1);
  });
  it('засвар түүхэнд хуучин/шинэ утгатай бичигдэнэ', async () => {
    const admin = await mk(['ADMIN']);
    const op = await mk(['OPERATOR']);
    await updateUser(admin.actor, op.id, { name: 'Шинэ нэр' });
    const h = await userHistory(admin.actor, op.id);
    const upd = h.items.find((i) => i.action === 'user.updated');
    expect(upd?.actorName).toBe(admin.name);
    expect(upd?.details).toMatchObject({ name: { from: op.name, to: 'Шинэ нэр' } });
  });
});

describe('үйлдлийн түүх', () => {
  it('засах, устгах боломжгүй (database хамгаалалт)', async () => {
    const admin = await mk(['ADMIN']);
    await createUser(admin.actor, { phone: '88005566', name: 'Түүх', roles: ['OPERATOR'] });
    const row = await db.auditLog.findFirstOrThrow({ where: { action: 'user.created' }, orderBy: { id: 'desc' } });
    await expect(db.auditLog.update({ where: { id: row.id }, data: { actorName: 'Хакер' } })).rejects.toThrow(/append-only/);
    await expect(db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe('TRUNCATE "AuditLog"')).rejects.toThrow(/append-only/);
  });
});

describe('хуучин системээс шилжсэн нууц үг', () => {
  it('bcrypt hash-тэй хэрэглэгч нэвтэрч, автоматаар scrypt болно', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const u = await db.user.create({ data: { phone: '77700001', name: 'Хуучин', roles: ['DRIVER'], passwordHash: bcrypt.hashSync('OldPass1', 10) } });
    await login(u.phone, 'OldPass1', meta);
    const fresh = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(fresh.passwordHash.startsWith('scrypt$')).toBe(true);
    expect((await login(u.phone, 'OldPass1', meta)).token).toBeTruthy();
  });
});

describe('database хамгаалалт', () => {
  it('8 оронтой бус утас, role-гүй хэрэглэгчийг database өөрөө хориглоно', async () => {
    await expect(db.user.create({ data: { phone: '123', name: 'X', roles: ['DRIVER'], passwordHash: 'x' } })).rejects.toThrow();
    await expect(db.user.create({ data: { phone: '77777777', name: 'X', roles: [], passwordHash: 'x' } })).rejects.toThrow();
  });
});
