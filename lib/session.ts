import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient, User } from '@prisma/client';
import { db } from './db';

type Tx = Prisma.TransactionClient | PrismaClient;

export const SESSION_COOKIE = 'zs';
export const SESSION_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
/** Сунгалтыг хэт олон бичихгүйн тулд 1 цагт нэг л удаа шинэчилнэ */
const TOUCH_EVERY_MS = 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newSessionToken(): { token: string; expiresAt: Date } {
  return { token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + SESSION_DAYS * DAY) };
}

export async function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null },
  tx: Tx = db,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY);
  await tx.session.create({
    data: { tokenHash: hashToken(token), userId, expiresAt, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null },
  });
  return { token, expiresAt };
}

export type SessionUser = Pick<User, 'id' | 'name' | 'phone' | 'roles' | 'mustChangePassword' | 'theme'>;

/**
 * Cookie-ийн токеноор хэрэглэгчийг олно. Хүчингүй/хугацаа дууссан/идэвхгүй хэрэглэгч → null.
 * Ашиглах бүрт 30 хоногоор сунгана (шийдвэр #16).
 */
export async function resolveSession(token: string | undefined | null): Promise<{ user: SessionUser; sessionId: string } | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const s = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true, expiresAt: true, revokedAt: true, lastSeenAt: true,
      user: { select: { id: true, name: true, phone: true, roles: true, mustChangePassword: true, theme: true, isActive: true } },
    },
  });
  const now = Date.now();
  if (!s || s.revokedAt || s.expiresAt.getTime() <= now || !s.user.isActive) return null;
  if (now - s.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await db.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date(now), expiresAt: new Date(now + SESSION_DAYS * DAY) } });
  }
  const { isActive: _ignored, ...user } = s.user;
  return { user, sessionId: s.id };
}

export async function revokeSession(sessionId: string, tx: Tx = db): Promise<void> {
  await tx.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Хэрэглэгчийн бүх нэвтрэлтийг хүчингүй болгоно (exceptId-ээс бусад) */
export async function revokeAllSessions(userId: string, tx: Tx = db, exceptId?: string): Promise<number> {
  const r = await tx.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return r.count;
}
