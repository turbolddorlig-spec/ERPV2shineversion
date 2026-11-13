import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** Аудит #146 — ажилтны цалин: Супер админы бодсоноос өөрчлөлт харагдана, «Шилжүүлсэн» зөвхөн цоожтой, код таах хязгаар, хязгаарууд */
let db: typeof import('@/lib/db').db;
let S: typeof import('@/lib/services/salary');
let U: typeof import('@/lib/ubdate');
beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  S = await import('@/lib/services/salary');
  U = await import('@/lib/ubdate');
});
let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(78000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: `10.0.0.${seq % 250}` };
}
async function err(p: Promise<unknown>, status: number, code?: string) {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AppError); expect((e as AppError).status).toBe(status); if (code) expect((e as AppError).code).toBe(code); return; }
  throw new Error(`Алдаа гарах ёстой байсан (${status})`);
}
let sa: UserActor; let acc: UserActor; let wh: UserActor; let drv: UserActor; let ym: string; let key: string;
beforeEach(async () => {
  await resetDb(db as never);
  S.resetUnlockFails();
  sa = await actor(['SUPER_ADMIN']); acc = await actor(['ACCOUNTING']); wh = await actor(['WAREHOUSE']); drv = await actor(['DRIVER']);
  ym = U.ubDay().slice(0, 7); key = `u:${wh.id}`;
});
const cell = async (k: string, i = 0) => (await S.salaryBoard(acc, ym)).rows.find((r) => r.key === k)!;

describe('#146 цалин', () => {
  it('Супер админы бодсоноос өөр хүн өөрчилбөл самбарт «Өөрчлөгдсөн» — юу, хэдээс хэд, хэн', async () => {
    await S.setConfig(sa, { staffKey: key, baseSalary: 1_500_000, bankAccount: '5000111' });
    const r = await S.saveSalary(sa, { staffKey: key, ym, half: 1, baseSalary: 500_000, version: 0 });
    let row = await cell(key);
    expect(row.periods[0]!.changes).toBeNull();
    expect(row.configChanged).toBeNull();
    await S.saveSalary(acc, { staffKey: key, ym, half: 1, baseSalary: 900_000, bankAccount: '9999', version: r.version });
    await S.setConfig(acc, { staffKey: key, baseSalary: 1_800_000, bankAccount: '5000111' });
    row = await cell(key);
    const ch = row.periods[0]!.changes!;
    expect(ch.find((c) => c.field === 'transferSalary')).toMatchObject({ from: 500_000, to: 900_000 });
    expect(ch.find((c) => c.field === 'bankAccount')).toMatchObject({ from: '5000111', to: '9999' });
    expect(row.periods[0]!.changedByName).toBe(acc.name);
    expect(row.periods[0]!.bankMismatch).toBe('9999');
    expect(row.configChanged!.find((c) => c.field === 'baseSalary')).toMatchObject({ from: 1_500_000, to: 1_800_000 });
    // данс солигдсоныг түүхэнд
    const h = await db.auditLog.findFirst({ where: { action: 'salary.updated' }, orderBy: { at: 'desc' } });
    expect(JSON.stringify(h!.details)).toContain('9999');
    // Супер админ шалгаад дахин хадгалбал — шинэ «анхны» утга
    const cur = (await db.staffSalaryRecord.findUniqueOrThrow({ where: { id: r.id } })).version;
    await S.saveSalary(sa, { staffKey: key, ym, half: 1, baseSalary: 900_000, bankAccount: '5000111', version: cur });
    expect((await cell(key)).periods[0]!.changes).toBeNull();
    // Супер админ огт бодоогүй цалин
    await S.saveSalary(acc, { staffKey: key, ym, half: 2, baseSalary: 100_000, version: 0 });
    expect((await cell(key)).periods[1]!.noSa).toBe(true);
  });

  it('«Шилжүүлсэн» зөвхөн цоожтойд; шилжүүлсэн цалинг тайлахгүй; буцаахыг зөвхөн Супер админ', async () => {
    const r = await S.saveSalary(acc, { staffKey: key, ym, half: 1, baseSalary: 500_000, version: 0 });
    await err(S.setTransferred(acc, r.id, true), 409, 'not_locked');
    await S.lockSalary(acc, r.id, r.version);
    await S.setTransferred(acc, r.id, true);
    await S.setLockCode(sa, { code: 'abc123' });
    await err(S.unlockSalary(acc, r.id, { code: 'abc123' }), 409, 'transferred');
    await err(S.setTransferred(acc, r.id, false), 403);
    await S.setTransferred(sa, r.id, false);
    await S.unlockSalary(acc, r.id, { code: 'abc123' });
  });

  it('цоожны код: 6+ тэмдэгт; 15 минутад 5 буруу оролдлогын дараа хаана', async () => {
    await err(S.setLockCode(sa, { code: '1234' }), 400);
    await S.setLockCode(sa, { code: 'secret99' });
    const r = await S.saveSalary(acc, { staffKey: key, ym, half: 1, baseSalary: 500_000, version: 0 });
    await S.lockSalary(acc, r.id);
    for (let i = 0; i < 5; i++) await err(S.unlockSalary(acc, r.id, { code: `x${i}` }), 403);
    await err(S.unlockSalary(acc, r.id, { code: 'secret99' }), 429, 'too_many'); // зөв код ч хаагдсан
    expect(await db.auditLog.count({ where: { action: 'salary.unlock_failed' } })).toBe(5);
  });

  it('хасах (−) дүн, хэт том дүн, 13-р сар, нуугдмал ажилтан, хоёр цонхноос анх хадгалах', async () => {
    await err(S.saveSalary(acc, { staffKey: key, ym, half: 1, baseSalary: 100, deductions: [{ label: 'x', amount: 900_000 }], version: 0 }), 400, 'negative');
    await err(S.saveSalary(acc, { staffKey: key, ym, half: 1, baseSalary: 0, additions: [{ amount: 1e9 }, { amount: 1e9 }, { amount: 1e9 }], version: 0 }), 400, 'too_large');
    await err(S.salaryBoard(acc, '2026-13'), 400);
    await err(S.saveSalary(acc, { staffKey: `u:${sa.id}`, ym, half: 1, baseSalary: 5_000_000, version: 0 }), 400, 'not_staff');
    await err(S.saveSalary(acc, { staffKey: `u:${drv.id}`, ym, half: 1, baseSalary: 5_000_000, version: 0 }), 400, 'not_staff');
    const x = await S.addExternal(acc, { name: 'Харуул', jobTitle: 'Харуул', baseSalary: 600_000 });
    const xr = await S.saveSalary(acc, { staffKey: `x:${x.id}`, ym, half: 1, version: 0 });
    await S.removeExternal(acc, x.id);
    await err(S.saveSalary(acc, { staffKey: `x:${x.id}`, ym, half: 2, baseSalary: 3_000_000, version: 0 }), 400, 'not_staff');
    // хассан ч тооцоо дутуу (шилжүүлээгүй) — самбарт үлдэнэ
    expect((await S.salaryBoard(acc, ym)).rows.some((r) => r.key === `x:${x.id}` && r.periods[0]?.id === xr.id)).toBe(true);
    // хоёр цонх: хоёулаа «шинэ» (version 0) — хоёр дахь нь дарахгүй
    await S.saveSalary(acc, { staffKey: key, ym, half: 1, baseSalary: 400_000, version: 0 });
    await err(S.saveSalary(acc, { staffKey: key, ym, half: 1, baseSalary: 900_000, version: 0 }), 409, 'stale');
  });

  it('цоожлохдоо: хадгалснаас хойш ажлын өдөр өөрчлөгдсөн бол «дахин хадгална уу»; цоожтой үед ажлын өдөр засахгүй', async () => {
    await S.setConfig(sa, { staffKey: key, baseSalary: 1_500_000 });
    const r = await S.saveSalary(acc, { staffKey: key, ym, half: 1, version: 0 });
    await S.setWorkDay(acc, { staffKey: key, date: `${ym}-03`, dayType: 'ABSENT' });
    await err(S.lockSalary(acc, r.id), 409, 'stale');
    const r2 = await S.saveSalary(acc, { staffKey: key, ym, half: 1, version: r.version });
    expect(r2.workingDays).toBe(r.workingDays - 1);
    await err(S.lockSalary(acc, r2.id, r.version), 409, 'stale'); // хуучин хувилбараар
    await S.lockSalary(acc, r2.id, r2.version);
    await err(S.setWorkDay(acc, { staffKey: key, date: `${ym}-04`, dayType: 'ABSENT' }), 409, 'locked');
  });

  it('нэг цалин түгжигдсэн үед хадгалах нь 8 сек-д «завгүй» (500 биш) — бусад хүсэлт хүлээхгүй', async () => {
    const { errorResponse } = await import('@/lib/http');
    const p = S.periodOf(ym, 1);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = db.$transaction(async (tx) => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(8::int4, hashtext(${key + p.start}))`; await held; }, { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    let caught: unknown = null;
    try { await S.saveSalary(acc, { staffKey: key, ym, half: 1, baseSalary: 100_000, version: 0 }); } catch (e) { caught = e; }
    const ms = Date.now() - t0;
    expect(caught).not.toBeNull();
    expect(errorResponse(caught).status).toBe(409);
    expect(ms).toBeLessThan(12_000);
    expect((await S.salaryBoard(acc, ym)).rows.length).toBeGreaterThan(0); // самбар хэвийн
    release(); await holder;
  }, 30_000);
});
