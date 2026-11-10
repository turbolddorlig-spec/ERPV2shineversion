import type { Prisma, PrismaClient } from '@prisma/client';
import { db } from './db';

type Tx = Prisma.TransactionClient | PrismaClient;

export interface Actor {
  id: string | null;
  name: string;
  ip?: string | null;
}

export const SYSTEM_ACTOR: Actor = { id: null, name: 'СИСТЕМ' };

/** Үйлдлийн түүхэнд нэг мөр нэмнэ. Боломжтой бол өөрчлөлттэй ижил transaction дотор дуудна. */
export async function writeAudit(
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string | null,
  details?: Prisma.InputJsonValue,
  tx: Tx = db,
  tags: string[] = [],
): Promise<void> {
  await tx.auditLog.create({
    data: { actorId: actor.id, actorName: actor.name, action, entityType, entityId, details, ip: actor.ip ?? null, tags },
  });
}

export const AUDIT_LABEL: Record<string, string> = {
  'auth.login': 'Нэвтэрсэн',
  'auth.login_failed': 'Буруу нууц үгээр оролдсон',
  'auth.locked': 'Түгжигдсэн (5 буруу оролдлого)',
  'auth.logout': 'Гарсан',
  'auth.logout_all': 'Бүх төхөөрөмжөөс гарсан',
  'auth.password_changed': 'Нууц үгээ сольсон',
  'user.created': 'Хэрэглэгч үүсгэсэн',
  'user.updated': 'Мэдээлэл засварласан',
  'user.deactivated': 'Эрхийг хаасан',
  'user.activated': 'Эрхийг нээсэн',
  'user.password_reset': 'Нууц үг сэргээсэн (түр нууц үг)',
  'user.unlocked': 'Түгжээ тайлсан',
  'user.theme': 'Өнгөний горим сольсон',
};
