import type { Prisma, Role } from '@prisma/client';
import { db } from '../../db';
import { badRequest, forbidden } from '../../errors';
import { writeAudit } from '../../audit';
import { canManageOrderSettings } from '../../permissions';
import { ubDay, ubDayStart } from '../../ubdate';
import type { UserActor } from '../users';

/**
 * #202 (эзний шийдвэр): операторын идэвхгүй байдлын сануулга — Супер админ, Ахлах операторт.
 * Ажлын цагт (цайны цагаас бусад) өнөөдөр «ажиллаж байна» гэж үзэх тооноос (анх 10) олон захиалга үүсгэсэн оператор
 * сүүлийн N минутад (анх 15) M ба түүнээс бага (анх 2) захиалга үүсгэсэн бол «шалгана уу» гэж сануулна.
 * Бүх тоо, цаг компани бүрт Тохиргоонд (MULTI_COMPANY). Захиалга «үүсгэсэн» = түүхийн «order.created» (мөнгө орсон / «Маргааш»-аар
 * үүссэн огноо солигдсон захиалга операторын идэвхэд тооцогдохгүй, #195).
 */
const KEY = 'operatorIdle';
export interface IdleConfig { enabled: boolean; start: string; lunchFrom: string; lunchTo: string; end: string; minToday: number; windowMin: number; maxInWindow: number }
export const IDLE_DEFAULT: IdleConfig = { enabled: true, start: '09:30', lunchFrom: '12:00', lunchTo: '13:00', end: '21:00', minToday: 10, windowMin: 15, maxInWindow: 2 };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const mins = (s: string) => { const m = HHMM.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };

export async function getIdleConfig(): Promise<IdleConfig> {
  const r = await db.appSetting.findUnique({ where: { key: KEY } });
  const v = (r?.value ?? {}) as Partial<IdleConfig>;
  return { ...IDLE_DEFAULT, ...v };
}

export async function setIdleConfig(actor: UserActor, input: Partial<Record<keyof IdleConfig, unknown>>) {
  if (!canManageOrderSettings(actor.roles)) throw forbidden();
  const cur = await getIdleConfig();
  const next: IdleConfig = { ...cur };
  if (input.enabled !== undefined) next.enabled = input.enabled === true;
  for (const k of ['start', 'lunchFrom', 'lunchTo', 'end'] as const) {
    if (input[k] !== undefined) { const s = String(input[k]).trim(); if (!HHMM.test(s)) throw badRequest('Цагийг ЦЦ:ММ хэлбэрээр бичнэ үү (жишээ 09:30)'); next[k] = s; }
  }
  const int = (v: unknown, lo: number, hi: number, name: string) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw badRequest(`${name}: ${lo}–${hi}`); return n; };
  if (input.minToday !== undefined) next.minToday = int(input.minToday, 0, 1000, '«Ажиллаж байна» гэж үзэх захиалга');
  if (input.windowMin !== undefined) next.windowMin = int(input.windowMin, 5, 240, 'Шалгах хугацаа (минут)');
  if (input.maxInWindow !== undefined) next.maxInWindow = int(input.maxInWindow, 0, 100, 'Хамгийн бага захиалга');
  if (!(mins(next.start) < mins(next.lunchFrom) && mins(next.lunchFrom) < mins(next.lunchTo) && mins(next.lunchTo) < mins(next.end))) {
    throw badRequest('Цагийн дараалал буруу: эхлэх < цай эхлэх < цай дуусах < дуусах');
  }
  await db.$transaction(async (tx) => {
    await tx.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: next as unknown as Prisma.InputJsonValue, updatedById: actor.id }, update: { value: next as unknown as Prisma.InputJsonValue, updatedById: actor.id } });
    await writeAudit(actor, 'settings.operator_idle', 'AppSetting', KEY, { from: cur, to: next } as unknown as Prisma.InputJsonValue, tx, ['settings']);
  });
  cache = null;
  return next;
}

/** Одоогийн УБ минут (0–1439); тестэд TEST_UB_HOUR */
function ubMinuteNow(): number {
  if (process.env.NODE_ENV === 'test' && process.env.TEST_UB_MINUTE) return Number(process.env.TEST_UB_MINUTE);
  if (process.env.NODE_ENV === 'test' && process.env.TEST_UB_HOUR) return Number(process.env.TEST_UB_HOUR) * 60;
  const d = new Date(Date.now() + 8 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export interface IdleOperator { operatorId: string; name: string; today: number; inWindow: number; windowMin: number }
let cache: { at: number; v: IdleOperator[] } | null = null;

/** Одоо идэвхгүй байгаа операторууд (ажлын цаг биш / цайны цаг бол хоосон) */
export async function idleOperators(now = new Date()): Promise<IdleOperator[]> {
  if (cache && Date.now() - cache.at < (process.env.NODE_ENV === 'test' ? 0 : 60_000)) return cache.v;
  const c = await getIdleConfig();
  const m = ubMinuteNow();
  const w = c.windowMin;
  // Бүтэн цонх ажлын цагт багтах ёстой: ажил эхэлснээс N минут өнгөрсөн, цайны цагтай давхцахгүй
  const inWork = m >= mins(c.start) + w && m <= mins(c.end);
  const overlapsLunch = m > mins(c.lunchFrom) && m - w < mins(c.lunchTo);
  if (!c.enabled || !inWork || overlapsLunch) { cache = { at: Date.now(), v: [] }; return []; }
  const since = new Date(now.getTime() - w * 60_000);
  const rows = await db.$queryRaw<{ actorId: string; name: string; today: number; inWindow: number }[]>`
    SELECT a."actorId", max(a."actorName") AS name, count(*)::int AS today, count(*) FILTER (WHERE a.at >= ${since})::int AS "inWindow"
    FROM "AuditLog" a
    WHERE a.at >= ${ubDayStart(ubDay(now))} AND a.action = 'order.created' AND a."actorId" IS NOT NULL
    GROUP BY a."actorId"`;
  const users = rows.length ? await db.user.findMany({ where: { id: { in: rows.map((r) => r.actorId) }, isActive: true }, select: { id: true, name: true, roles: true } }) : [];
  const ops = new Map(users.filter((u) => u.roles.some((r) => r === 'OPERATOR' || r === 'OPERATOR_LEAD')).map((u) => [u.id, u.name]));
  const v = rows.filter((r) => ops.has(r.actorId) && r.today >= c.minToday && r.inWindow <= c.maxInWindow)
    .map((r) => ({ operatorId: r.actorId, name: ops.get(r.actorId) ?? r.name, today: r.today, inWindow: r.inWindow, windowMin: w }))
    .sort((a, b) => a.inWindow - b.inWindow || a.name.localeCompare(b.name));
  cache = { at: Date.now(), v };
  return v;
}

/** Бүх хуудасны дээд талд — Супер админ, Ахлах оператор */
export async function idleOperatorsAlert(roles: Role[]): Promise<IdleOperator[] | null> {
  if (!roles.includes('SUPER_ADMIN') && !roles.includes('OPERATOR_LEAD')) return null;
  const v = await idleOperators();
  return v.length ? v : null;
}
