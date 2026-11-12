import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/reset';

/** Аудит №1: арын ажлын ээлж (давхардахгүй, гацахгүй), ажил бүр тусдаа, heartbeat анхааруулга; шөнийн өр хоцорвол алгасна */
let db: typeof import('@/lib/db').db;
let J: typeof import('@/lib/jobs');
let DB: typeof import('@/lib/services/accounting/debts');
let U: typeof import('@/lib/ubdate');
beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  J = await import('@/lib/jobs');
  DB = await import('@/lib/services/accounting/debts');
  U = await import('@/lib/ubdate');
});
beforeEach(async () => { await resetDb(db as never); });
const ubAt = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+08:00`);

describe('арын ажлын ээлж', () => {
  it('дараалан 10 удаа — бүгд ажиллана (хуучин түгжээ ихэнхдээ алгасдаг байсан), ээлж чөлөөлөгдөнө', async () => {
    for (let i = 0; i < 10; i++) {
      // зэрэгцээ өөр асуулга явж байхад ч (холболтын сан өөр холболт өгнө)
      const [r] = await Promise.all([J.runJobsOnce(), db.$queryRaw`SELECT pg_sleep(0.01)::text AS s`, db.user.count()]);
      expect(r.ran).toBe(true);
      expect(r.failed).toEqual([]);
    }
    const lease = await db.appSetting.findUnique({ where: { key: 'jobs.lease' } });
    expect(Date.parse((lease!.value as { until: string }).until)).toBeLessThan(Date.now());
    const hb = await db.appSetting.findUnique({ where: { key: 'jobs.heartbeat' } });
    expect(Date.now() - Date.parse((hb!.value as { at: string }).at)).toBeLessThan(60_000);
  });

  it('нэг процесс дотор зэрэг дуудахад нэг л удаа ажиллана', async () => {
    const rs = await Promise.all([J.runJobsOnce(), J.runJobsOnce(), J.runJobsOnce()]);
    expect(rs.filter((r) => r.ran)).toHaveLength(1);
  });

  it('өөр процесс ээлжтэй үед авахгүй; чөлөөлсний дараа эсвэл хугацаа дуусвал авна (гацахгүй)', async () => {
    expect(await J._lease.acquire('A')).toBe(true);
    expect(await J._lease.acquire('B')).toBe(false);
    expect((await J.runJobsOnce({ owner: 'B' })).ran).toBe(false);
    expect(await J._lease.acquire('A')).toBe(true); // өөрийнхөө ээлжийг сунгана
    await J._lease.release('B'); // бусдынхыг чөлөөлж чадахгүй
    expect(await J._lease.acquire('B')).toBe(false);
    await J._lease.release('A');
    expect(await J._lease.acquire('B')).toBe(true);
    // B унасан (чөлөөлөөгүй) — хугацаа дуусахад C авна
    expect(await J._lease.acquire('C')).toBe(false);
    expect(await J._lease.acquire('C', new Date(Date.now() + J._lease.LEASE_MS + 1000))).toBe(true);
  });

  it('heartbeat: 10+ мин ажиллаагүй бол зөвхөн Супер админд анхааруулга; анх суулгасан (heartbeat-гүй) үед гарахгүй', async () => {
    J._lease.bust();
    expect(await J.jobsAlert(['SUPER_ADMIN'])).toBeNull();
    const old = new Date(Date.now() - J.JOBS_STALE_MS - 60_000).toISOString();
    await db.appSetting.create({ data: { key: 'jobs.heartbeat', value: { at: old, failed: [] } } });
    J._lease.bust();
    expect(await J.jobsAlert(['ADMIN'])).toBeNull();
    expect((await J.jobsAlert(['SUPER_ADMIN']))?.at).toBe(old);
    await J.runJobsOnce(); // ажиллахад анхааруулга арилна
    expect(await J.jobsAlert(['SUPER_ADMIN'])).toBeNull();
  });

  it('нэг ажил алдаа гаргасан ч бусад нь ажиллаж, heartbeat-д бичигдэнэ', async () => {
    // Gmail тохиргоог эвдэрсэн JSON болгоно — gmail ажил алдаа гаргавал бусад нь (тулгалт, нэмэлт бараа) үргэлжилнэ
    await db.appSetting.create({ data: { key: 'gmail', value: 'эвдэрсэн' } }).catch(() => null);
    const r = await J.runJobsOnce();
    expect(r.ran).toBe(true);
    expect(r.reconciled).toBe(true);
    const hb = await db.appSetting.findUnique({ where: { key: 'jobs.heartbeat' } });
    expect((hb!.value as { failed: string[] }).failed).toEqual(r.failed);
  });
});

describe('шөнийн дутуу барааны өр — хоцорвол алгасна', () => {
  it('00:05-д ажиллавал өчигдрийг хаана; 06:00-оос хойш бол бичихгүй, СА/нягтланд анхааруулна; дараагийн амжилттай хаалт арилгана', async () => {
    const today = U.ubDay();
    const y = U.ubDay(new Date(), -1);
    const r1 = await DB.closeDayShortages(ubAt(y, '00:05'));
    expect(r1.ran).toBe(true);
    expect(await DB.shortageSkipAlert(['ACCOUNTING'])).toBeNull();
    // Дараагийн өдөр (өнөөдөр) серверийн уналтын улмаас 09:30-д анх ажиллав
    const debtsBefore = await db.companyDebt.count();
    const r2 = await DB.closeDayShortages(ubAt(today, '09:30'));
    expect(r2).toMatchObject({ ran: false, skipped: true, date: y });
    expect(await db.companyDebt.count()).toBe(debtsBefore);
    expect((await DB.shortageSkipAlert(['ACCOUNTING']))?.date).toBe(y);
    expect((await DB.shortageSkipAlert(['SUPER_ADMIN']))?.date).toBe(y);
    expect(await DB.shortageSkipAlert(['DRIVER'])).toBeNull();
    expect((await DB.closeDayShortages(ubAt(today, '10:00'))).ran).toBe(false); // дахин оролдохгүй
    const audit = await db.auditLog.findFirst({ where: { action: 'debt.shortage_skipped' } });
    expect(audit).not.toBeNull();
    // Маргааш 00:05-д хэвийн ажиллана → анхааруулга арилна
    const r3 = await DB.closeDayShortages(ubAt(U.ubDay(new Date(), 1), '00:05'));
    expect(r3.ran).toBe(true);
    expect(await DB.shortageSkipAlert(['ACCOUNTING'])).toBeNull();
  });

  it('анх суулгасан өдөр (өмнө нь хаагаагүй) хоцорсон бол анхааруулгагүй өнгөрнө', async () => {
    const r = await DB.closeDayShortages(ubAt(U.ubDay(), '11:00'));
    expect(r.ran).toBe(false);
    expect(r.skipped).toBeUndefined();
    expect(await DB.shortageSkipAlert(['SUPER_ADMIN'])).toBeNull();
  });
});

describe('«Бараа татах» тооцооны кэш (аудит №3)', () => {
  it('зэрэг хүсэлтүүд нэг л тооцоо хийнэ; кэш хуучирвал хуучнаа шууд буцааж ар талд шинэчилнэ; өөрчлөлтийн дараа шинээр бодно', async () => {
    const O = await import('@/lib/services/outflow');
    O.bustOutflowCache();
    const [a, b, c] = await Promise.all([O.computeReorder(), O.computeReorder(), O.computeReorder()]);
    expect(b).toBe(a); expect(c).toBe(a);
    expect(await O.computeReorder()).toBe(a); // 1 минутын дотор — кэш
    O.bustOutflowCache();
    const d = await O.computeReorder();
    expect(d).not.toBe(a);
    // арын ажил кэшийг шинэчилнэ
    await J.runJobsOnce();
    expect(await O.computeReorder()).not.toBe(d);
  });
});
