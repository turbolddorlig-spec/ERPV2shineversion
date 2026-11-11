import type { Theme } from '@prisma/client';
import { db } from '../db';
import { writeAudit, SYSTEM_ACTOR } from '../audit';
import { normalizePhone } from '../phone';
import { dummyVerify, hashPassword, needsRehash, passwordProblem, verifyPassword } from '../password';
import { hashToken, newSessionToken, revokeAllSessions, revokeSession } from '../session';
import { AppError, badRequest } from '../errors';
import { officeBlock } from './office';

export const MAX_FAILED = 5;
export const LOCK_MINUTES = 15;

const GENERIC_FAIL = 'Утасны дугаар эсвэл нууц үг буруу байна';

export interface ClientMeta {
  ip?: string | null;
  userAgent?: string | null;
}

function lockMessage(until: Date): string {
  const hhmm = until.toLocaleTimeString('mn-MN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ulaanbaatar' });
  return `Олон удаа буруу оролдсон тул ${hhmm} хүртэл түгжигдлээ. Яаралтай бол админд хандаж түгжээг тайлуулна уу.`;
}

export async function login(phoneInput: string, password: string, meta: ClientMeta) {
  const phone = normalizePhone(phoneInput);
  if (!phone || typeof password !== 'string' || !password) throw badRequest('Утас болон нууц үгээ оруулна уу');

  const user = await db.user.findUnique({ where: { phone } });
  if (!user || !user.isActive) {
    await dummyVerify(password);
    throw new AppError(401, GENERIC_FAIL, 'invalid_credentials');
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw new AppError(423, lockMessage(user.lockedUntil), 'locked');
  }

  // Хуулж буулгахад өмнө/ард зай орсон бол (утсан дээр түгээмэл) тайрсан хувилбараар дахин шалгана
  const ok = (await verifyPassword(password, user.passwordHash)) || (password.trim() !== password && password.trim().length > 0 && (await verifyPassword(password.trim(), user.passwordHash)));
  const actor = { id: user.id, name: user.name, ip: meta.ip ?? null };

  if (!ok) {
    // Атомаар нэмэгдүүлнэ — зэрэг оролдлогод тоо алдагдахгүй
    const rows = await db.$queryRaw<{ failedLoginCount: number }[]>`
      UPDATE "User" SET "failedLoginCount" = "failedLoginCount" + 1, "updatedAt" = now()
      WHERE id = ${user.id}::uuid RETURNING "failedLoginCount"`;
    const count = rows[0]?.failedLoginCount ?? 0;
    if (count >= MAX_FAILED) {
      const until = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
      await db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { lockedUntil: until, failedLoginCount: 0 } });
        await writeAudit(actor, 'auth.locked', 'User', user.id, { until: until.toISOString() }, tx);
      });
      throw new AppError(423, lockMessage(until), 'locked');
    }
    await writeAudit(actor, 'auth.login_failed', 'User', user.id, { attempt: count });
    throw new AppError(401, GENERIC_FAIL, 'invalid_credentials');
  }

  // «Зөвхөн ажлын байрнаас» (#86): сонгосон ролтой бол ажлын IP-аас л
  const office = await officeBlock(user.roles, meta.ip);
  if (office) {
    await writeAudit(actor, 'auth.office_blocked', 'User', user.id, { ip: meta.ip ?? null });
    throw new AppError(403, office, 'office_only');
  }

  // Богино, нэг удаагийн гүйлгээ (interactive биш) — ачаалал ихтэй үед ч хугацаа хэтрэхгүй
  const { token, expiresAt } = newSessionToken();
  const rehash = needsRehash(user.passwordHash) ? await hashPassword(password) : null;
  await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), ...(rehash ? { passwordHash: rehash } : {}) },
    }),
    db.session.create({
      data: { tokenHash: hashToken(token), userId: user.id, expiresAt, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null },
    }),
    db.auditLog.create({
      data: {
        actorId: actor.id, actorName: actor.name, action: 'auth.login', entityType: 'User', entityId: user.id,
        ip: actor.ip, details: { userAgent: meta.userAgent?.slice(0, 120) ?? null },
      },
    }),
  ]);
  return { token, expiresAt, user: { id: user.id, roles: user.roles, theme: user.theme, mustChangePassword: user.mustChangePassword } };
}

export async function logout(sessionId: string, actor: { id: string; name: string; ip?: string | null }) {
  await revokeSession(sessionId);
  await writeAudit(actor, 'auth.logout', 'User', actor.id);
}

export async function logoutEverywhere(actor: { id: string; name: string; ip?: string | null }) {
  const n = await revokeAllSessions(actor.id);
  await writeAudit(actor, 'auth.logout_all', 'User', actor.id, { sessions: n });
}

/** Өөрийн нууц үг солих. Бусад бүх төхөөрөмжөөс гаргана, одоогийн нэвтрэлт үлдэнэ. */
export async function changeOwnPassword(
  actor: { id: string; name: string; ip?: string | null },
  sessionId: string,
  currentPassword: string,
  newPassword: string,
) {
  const problem = passwordProblem(newPassword);
  if (problem) throw badRequest(problem, 'weak_password');
  if (currentPassword === newPassword) throw badRequest('Шинэ нууц үг хуучнаасаа өөр байх ёстой', 'same_password');

  const user = await db.user.findUniqueOrThrow({ where: { id: actor.id } });
  if (!(await verifyPassword(currentPassword ?? '', user.passwordHash))) {
    throw new AppError(400, 'Одоогийн нууц үг буруу байна', 'wrong_password');
  }
  const passwordHash = await hashPassword(newPassword);
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: actor.id }, data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() } });
    await revokeAllSessions(actor.id, tx, sessionId);
    await writeAudit(actor, 'auth.password_changed', 'User', actor.id, undefined, tx);
  });
}

export async function setTheme(actor: { id: string; name: string }, theme: Theme) {
  await db.user.update({ where: { id: actor.id }, data: { theme } });
}

export { SYSTEM_ACTOR };
