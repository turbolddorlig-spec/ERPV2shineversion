import type { Prisma, Role } from '@prisma/client';
import { db } from '../db';
import { badRequest, forbidden } from '../errors';
import { writeAudit } from '../audit';
import { canEdit } from '../permissions';
import { ALL_ROLES, ROLE_LABEL } from '../roles';
import type { UserActor } from './users';

/**
 * «Зөвхөн ажлын байрнаас» (эзний хүсэлт, #86): Тохиргоо дээр сонгосон ролтой ажилтан зөвхөн ажлын интернэтийн IP-аас нэвтэрнэ.
 * Ажлын сүлжээнд байвал утсаар ч болно; IP бүртгээгүй / унтраалттай бол хаанаас ч болно.
 * Хүсэлт бүрт шалгана — ажил дээрээ нэвтэрч гэртээ очвол хуудас нээгдэхгүй.
 * Олон ролтой бол хязгааргүй өөр ролтой бол чөлөөтэй (хамгийн өндөр эрх, #18). Супер админыг хэзээ ч хязгаарлахгүй (түгжигдэхгүй).
 */
const KEY = 'access.office';
export interface OfficeIp { ip: string; label: string }
export interface OfficeSettings { enabled: boolean; roles: Role[]; ips: OfficeIp[] }
const DEFAULTS: OfficeSettings = { enabled: false, roles: ['OPERATOR', 'MARKETING'], ips: [] };
export const OFFICE_MESSAGE = 'Та зөвхөн ажлын байрнаас (ажлын интернэтээр) нэвтэрнэ';
const NEVER: Role[] = ['SUPER_ADMIN'];

let cache: { at: number; v: OfficeSettings } | null = null;
export async function readOffice(): Promise<OfficeSettings> {
  if (cache && Date.now() - cache.at < 15_000) return cache.v;
  const s = await db.appSetting.findUnique({ where: { key: KEY } });
  const v = { ...DEFAULTS, ...((s?.value as object | null) ?? {}) } as OfficeSettings;
  cache = { at: Date.now(), v };
  return v;
}

/** IPv4 / IPv6-д mapped хаягийг цэвэрлэнэ */
export function normIp(ip: string | null | undefined): string {
  const s = String(ip ?? '').trim().toLowerCase();
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}
const v4 = (s: string) => { const p = s.split('.').map(Number); return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]! : null; };
/** «1.2.3.4» эсвэл «1.2.3.0/24» эсвэл IPv6 яг ижил */
export function ipMatches(rule: string, ipIn: string): boolean {
  const ip = normIp(ipIn); const r = normIp(rule);
  if (!ip || !r) return false;
  if (r.includes('/')) {
    const [base, bitsS] = r.split('/');
    const bits = Number(bitsS); const a = v4(base!); const b = v4(ip);
    if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  }
  return r === ip;
}
export const validIpRule = (s: string) => {
  const r = normIp(s);
  if (r.includes('/')) { const [b, n] = r.split('/'); return v4(b!) !== null && Number.isInteger(Number(n)) && Number(n) >= 8 && Number(n) <= 32; }
  return v4(r) !== null || /^[0-9a-f:]{2,39}$/.test(r);
};

/** Хязгаарлагдсан эсэх: null = болно, string = хориглох шалтгаан */
export async function officeBlock(roles: Role[], ip: string | null | undefined): Promise<string | null> {
  const s = await readOffice();
  if (!s.enabled || !s.ips.length || !s.roles.length) return null;
  if (roles.some((r) => NEVER.includes(r))) return null;
  if (!roles.length || roles.some((r) => !s.roles.includes(r))) return null;
  if (ip && s.ips.some((x) => ipMatches(x.ip, ip))) return null;
  return OFFICE_MESSAGE;
}

export async function officeView(actor: UserActor, currentIp: string | null) {
  if (!canEdit(actor.roles, 'settings')) throw forbidden();
  const s = await readOffice();
  return { ...s, currentIp: normIp(currentIp) || null, roleOptions: ALL_ROLES.filter((r) => !NEVER.includes(r)).map((r) => ({ role: r, label: ROLE_LABEL[r] })) };
}

export async function setOffice(actor: UserActor, input: { enabled?: unknown; roles?: unknown; ips?: unknown }, currentIp: string | null) {
  if (!canEdit(actor.roles, 'settings')) throw forbidden();
  const roles = (Array.isArray(input.roles) ? input.roles : []).map(String).filter((r): r is Role => (ALL_ROLES as string[]).includes(r) && !NEVER.includes(r as Role));
  const ips: OfficeIp[] = [];
  for (const x of (Array.isArray(input.ips) ? input.ips : []).slice(0, 50)) {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const ip = normIp(String(o.ip ?? ''));
    if (!ip) continue;
    if (!validIpRule(ip)) throw badRequest(`IP хаяг буруу: ${ip}`, 'bad_ip');
    if (!ips.some((y) => y.ip === ip)) ips.push({ ip, label: String(o.label ?? '').trim().slice(0, 60) });
  }
  const enabled = input.enabled === true;
  if (enabled && !ips.length) throw badRequest('Ажлын интернэтийн IP-г дор хаяж нэгийг нэмнэ үү («Одоогийн IP-г нэмэх»)', 'no_ips');
  if (enabled && !roles.length) throw badRequest('Хязгаарлах ролоо сонгоно уу', 'no_roles');
  // Өөрийгөө түгжихээс сэргийлнэ
  const self = { enabled, roles, ips };
  if (enabled && !actor.roles.some((r) => NEVER.includes(r)) && actor.roles.every((r) => roles.includes(r)) && !(currentIp && ips.some((x) => ipMatches(x.ip, currentIp))))
    throw badRequest('Та одоо ажлын IP-аас гадуур байна — хадгалбал өөрөө нэвтэрч чадахгүй болно. Эхлээд «Одоогийн IP-г нэмэх» дарна уу', 'self_lock');
  await db.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: self as unknown as Prisma.InputJsonValue, updatedById: actor.id }, update: { value: self as unknown as Prisma.InputJsonValue, updatedById: actor.id } });
  cache = null;
  await writeAudit(actor, 'settings.office_access', 'AppSetting', KEY, self as unknown as Prisma.InputJsonValue, db, ['settings', 'security']);
  return officeView(actor, currentIp);
}
