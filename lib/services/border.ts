import type { Prisma, Role } from '@prisma/client';
import { db } from '../db';
import { badRequest, forbidden } from '../errors';
import { writeAudit } from '../audit';
import { isYmd, ubDay } from '../ubdate';
import type { UserActor } from './users';

/**
 * #214 (эзэн): Замын-Үүдийн хил хаагдах өдрүүд — Тохиргоонд гараар бичнэ (компани бүр өөрөө, MULTI_COMPANY).
 * Хаалт эхлэх өдрөөс warnMonths (анх 1) САРЫН өмнөөс (2/6 → 1/6) хаалт дуустал бүх хуудасны дээд талд улаан мэдэгдэл
 * (Супер админ, Бараа захиалгын ажилтан). Бараа татах тооцоонд нөлөөлөхгүй — эзэн өөрөө тооцоолж нөөцөлнө.
 */
const KEY = 'borderClosures';
export interface BorderClosure { name: string; from: string; to: string }
export interface BorderConfig { warnMonths: number; items: BorderClosure[] }
const DEFAULT: BorderConfig = { warnMonths: 1, items: [] };
/** Календарийн сараар хасна (сарын сүүлийн өдөр хэтэрвэл тэр сарын сүүлийн өдөр) */
export function minusMonths(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 - n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}
const ROLES: Role[] = ['SUPER_ADMIN', 'PURCHASER'];

export async function getBorder(): Promise<BorderConfig> {
  const r = await db.appSetting.findUnique({ where: { key: KEY } });
  const v = (r?.value ?? {}) as Partial<BorderConfig>;
  return { warnMonths: v.warnMonths ?? DEFAULT.warnMonths, items: Array.isArray(v.items) ? v.items : [] };
}

export async function setBorder(actor: UserActor, input: { warnMonths?: unknown; items?: unknown }) {
  if (!actor.roles.includes('SUPER_ADMIN')) throw forbidden('Зөвхөн Супер админ');
  const cur = await getBorder();
  const warnMonths = input.warnMonths === undefined ? cur.warnMonths : Number(input.warnMonths);
  if (!Number.isInteger(warnMonths) || warnMonths < 1 || warnMonths > 6) throw badRequest('Хэдэн сарын өмнөөс: 1–6');
  const raw = Array.isArray(input.items) ? input.items.slice(0, 50) : cur.items;
  const items: BorderClosure[] = raw.map((x, i) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const name = String(o.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const from = String(o.from ?? ''); const to = String(o.to ?? '');
    if (!name) throw badRequest(`${i + 1}-р мөр: нэрээ бичнэ үү (жишээ «Цагаан сар»)`);
    if (!isYmd(from) || !isYmd(to)) throw badRequest(`«${name}»: эхлэх, дуусах өдрөө сонгоно уу`);
    if (to < from) throw badRequest(`«${name}»: дуусах өдөр эхлэхээс өмнө байж болохгүй`);
    return { name, from, to };
  }).sort((a, b) => a.from.localeCompare(b.from));
  const next: BorderConfig = { warnMonths, items };
  await db.$transaction(async (tx) => {
    await tx.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: next as unknown as Prisma.InputJsonValue, updatedById: actor.id }, update: { value: next as unknown as Prisma.InputJsonValue, updatedById: actor.id } });
    await writeAudit(actor, 'settings.border', 'AppSetting', KEY, { from: cur, to: next } as unknown as Prisma.InputJsonValue, tx, ['settings']);
  });
  cache = null;
  return next;
}

export interface BorderAlert { name: string; from: string; to: string; days: number; daysLeft: number; closed: boolean }
let cache: { at: number; day: string; v: BorderAlert[] } | null = null;
/** Одоо мэдэгдэх ёстой хаалтууд: эхлэхээс warnMonths сарын өмнөөс дуустал */
export async function borderAlert(roles: Role[], today = ubDay()): Promise<BorderAlert[] | null> {
  if (!roles.some((r) => ROLES.includes(r))) return null;
  if (!cache || cache.day !== today || process.env.NODE_ENV === 'test' || Date.now() - cache.at > 60_000) {
    const c = await getBorder();
    const v = c.items.filter((x) => today <= x.to && minusMonths(x.from, c.warnMonths) <= today).map((x) => ({
      name: x.name, from: x.from, to: x.to,
      days: Math.round((Date.parse(x.to) - Date.parse(x.from)) / 86_400_000) + 1,
      daysLeft: Math.round((Date.parse(x.from) - Date.parse(today)) / 86_400_000), closed: x.from <= today,
    }));
    cache = { at: Date.now(), day: today, v };
  }
  return cache.v.length ? cache.v : null;
}
