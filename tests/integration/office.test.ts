import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import { resetDb } from '../helpers/reset';

/** «Зөвхөн ажлын байрнаас нэвтрэх» (#86): сонгосон ролууд зөвхөн ажлын IP-аас; тохируулаагүй бол хаанаас ч */
let db: typeof import('@/lib/db').db;
let OF: typeof import('@/lib/services/office');
let AU: typeof import('@/lib/services/auth');
let hash: string;
const PW = 'Office1234!';

beforeAll(async () => {
  db = (await import('@/lib/db')).db;
  OF = await import('@/lib/services/office');
  AU = await import('@/lib/services/auth');
  hash = await (await import('@/lib/password')).hashPassword(PW);
});
let seq = 0;
async function user(roles: Role[]) {
  seq++;
  const u = await db.user.create({ data: { phone: String(77000000 + seq), name: `Тест ${seq}`, roles, passwordHash: hash } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1', phone: u.phone };
}
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'ok'; } catch (e) { expect(e).toBeInstanceOf(AppError); return (e as AppError).code ?? 'err'; }
}
beforeEach(async () => { await resetDb(db as never); });

describe('ажлын IP', () => {
  it('ipMatches: яг ижил, CIDR, IPv6-mapped', () => {
    expect(OF.ipMatches('202.21.100.5', '202.21.100.5')).toBe(true);
    expect(OF.ipMatches('202.21.100.5', '::ffff:202.21.100.5')).toBe(true);
    expect(OF.ipMatches('202.21.100.0/24', '202.21.100.77')).toBe(true);
    expect(OF.ipMatches('202.21.100.0/24', '202.21.101.1')).toBe(false);
    expect(OF.ipMatches('202.21.100.5', '202.21.100.6')).toBe(false);
    expect(OF.validIpRule('1.2.3')).toBe(false);
  });

  it('тохируулаагүй бол хаанаас ч; асаавал оператор зөвхөн ажлын IP-аас (нэвтрэх ба хүсэлт бүр); бусад роль, олон роль, Супер админ чөлөөтэй', async () => {
    const sa = await user(['SUPER_ADMIN']);
    const op = await user(['OPERATOR']);
    const mk = await user(['MARKETING']);
    const mkWh = await user(['MARKETING', 'WAREHOUSE']);
    const drv = await user(['DRIVER']);
    const home = { ip: '8.8.8.8', userAgent: 'iPhone' };
    const office = { ip: '202.21.100.5', userAgent: 'iPhone' };
    expect(await code(AU.login(op.phone, PW, home))).toBe('ok');
    // Хамгаалалт: IP-гүй асаах болохгүй, өөрийгөө түгжихгүй
    const adm = await user(['ADMIN']);
    expect(await code(OF.setOffice(adm, { enabled: true, roles: ['OPERATOR'], ips: [] }, office.ip))).toBe('no_ips');
    expect(await code(OF.setOffice(adm, { enabled: true, roles: ['ADMIN'], ips: [{ ip: '202.21.100.5' }] }, home.ip))).toBe('self_lock');
    expect(await code(OF.setOffice(op, { enabled: true, roles: ['OPERATOR'], ips: [{ ip: '202.21.100.5' }] }, office.ip))).toBe('forbidden');
    const v = await OF.setOffice(sa, { enabled: true, roles: ['OPERATOR', 'MARKETING', 'SUPER_ADMIN'], ips: [{ ip: '202.21.100.5', label: 'Оффис' }, { ip: '202.21.100.5' }] }, home.ip);
    expect([v.roles, v.ips.length, v.currentIp]).toEqual([['OPERATOR', 'MARKETING'], 1, '8.8.8.8']);
    expect(await code(AU.login(op.phone, PW, home))).toBe('office_only');
    expect(await code(AU.login(op.phone, PW, office))).toBe('ok'); // ажлын сүлжээнд утсаар ч болно
    expect(await code(AU.login(mk.phone, PW, home))).toBe('office_only');
    expect(await code(AU.login(mkWh.phone, PW, home))).toBe('ok');
    expect(await code(AU.login(drv.phone, PW, home))).toBe('ok');
    expect(await code(AU.login(sa.phone, PW, home))).toBe('ok');
    // Хүсэлт бүрт: ажил дээрээ нэвтэрсэн ч гэрээс бол хориг
    expect(await OF.officeBlock(op.roles, home.ip)).toBe(OF.OFFICE_MESSAGE);
    expect(await OF.officeBlock(op.roles, office.ip)).toBe(null);
    expect(await db.auditLog.count({ where: { action: 'auth.office_blocked' } })).toBe(2);
    // Унтраавал дахин хаанаас ч
    await OF.setOffice(sa, { enabled: false, roles: ['OPERATOR'], ips: [{ ip: '202.21.100.5' }] }, home.ip);
    expect(await code(AU.login(op.phone, PW, home))).toBe('ok');
  });
});
