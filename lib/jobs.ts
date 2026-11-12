import { randomUUID } from 'node:crypto';
import { db } from './db';
import { autoCancelExpired } from './services/orders/orders';
import { processMetaQueue } from './services/orders/meta';
import { autoReconcile } from './services/stock/views';
import { closeDayShortages } from './services/accounting/debts';
import { autoGmailSync } from './services/accounting/gmail';
import { rescanUnmatched } from './services/accounting/bank';
import { expireExtraRequests } from './services/delivery/goods';

/**
 * Арын ажил (минут тутам): Meta Purchase илгээх / дахин оролдох, хугацаа нь дууссан «Төлбөр хүлээж буй» захиалгыг цуцлах,
 * цаг тутам үлдэгдлийн тулгалт (журнал = үлдэгдэл, B2/R2), шөнийн дутуу барааны өр, Gmail, нэмэлт барааны хүсэлтийн хугацаа.
 *
 * Давхар ажиллахаас хамгаалалт (аудит №1): өмнө нь session-level advisory lock-ийг холболтын санаар (pool) авдаг байсан тул
 * өөр холболтоор тайлагдахгүй гацаж, ажлууд санамсаргүй алгасагддаг байв. Одоо:
 *  - процесс дотор: `running` тэмдэг (нэг процесс зэрэг 2 удаа ажиллуулахгүй);
 *  - процессуудын хооронд: database дахь «ээлжийн тэмдэглэл» (AppSetting 'jobs.lease', хугацаатай) — нэг атомар UPDATE-ээр авна,
 *    процесс унасан ч LEASE_MS-ийн дараа өөрөө чөлөөлөгдөнө (хэзээ ч гацахгүй).
 * Ажил бүр тусдаа хамгаалагдсан — нэг нь алдаа гаргавал бусад нь үргэлжилнэ. Сүүлд ажилласан цаг 'jobs.heartbeat'-д бичигдэнэ.
 */
const LEASE_KEY = 'jobs.lease';
const HEARTBEAT_KEY = 'jobs.heartbeat';
const LEASE_MS = 5 * 60_000;
export const JOBS_STALE_MS = 10 * 60_000;
const OWNER = `${process.pid}-${randomUUID()}`;
let running = false;

/** Ээлж авах: хугацаа нь дууссан эсвэл өөрийнх бол л авна (атомар) */
async function acquireLease(owner: string, now = new Date()): Promise<boolean> {
  const value = JSON.stringify({ owner, until: new Date(now.getTime() + LEASE_MS).toISOString() });
  const rows = await db.$queryRaw<{ key: string }[]>`
    INSERT INTO "AppSetting" (key, value, "updatedAt") VALUES (${LEASE_KEY}, ${value}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()
      WHERE ("AppSetting".value->>'until')::timestamptz < ${now.toISOString()}::timestamptz OR "AppSetting".value->>'owner' = ${owner}
    RETURNING key`;
  return rows.length > 0;
}
async function releaseLease(owner: string) {
  await db.$executeRaw`UPDATE "AppSetting" SET value = jsonb_set(value, '{until}', to_jsonb(${new Date(0).toISOString()}::text)), "updatedAt" = now()
    WHERE key = ${LEASE_KEY} AND value->>'owner' = ${owner}`;
}

type JobResult = { ran: boolean; cancelled?: number; meta?: { sent: number; failed: number }; reconciled?: boolean; failed?: string[] };

export async function runJobsOnce(opts: { owner?: string } = {}): Promise<JobResult> {
  if (running) return { ran: false };
  running = true;
  const owner = opts.owner ?? OWNER;
  try {
    if (!(await acquireLease(owner))) return { ran: false };
    const failed: string[] = [];
    const safe = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
      try { return await fn(); } catch (e) { failed.push(name); console.error(`[jobs] ${name}`, (e as Error).message); return null; }
    };
    try {
      const cancelled = await safe('auto-cancel', autoCancelExpired);
      const meta = await safe('meta', processMetaQueue);
      const rec = await safe('reconcile', autoReconcile);
      if (rec && !rec.ok) console.error(`[jobs] ҮЛДЭГДЛИЙН ЗӨРҮҮ: ${rec.count}`);
      // Модуль 6: өдрийн эцэст жолоочид буцаагаагүй бараа → автомат өр (өдөрт нэг удаа; 06:00-оос хойш бол алгасаад анхааруулна)
      const shortage = await safe('shortage', () => closeDayShortages());
      if (shortage?.ran) console.log(`[jobs] дутуу барааны өр ${shortage.date}: +${shortage.created} ~${shortage.changed} ✓${shortage.resolved}`);
      if (shortage?.skipped) console.error(`[jobs] ${shortage.date}-ны дутуу барааны өр хоцорсон тул бичигдсэнгүй — анхааруулга гарлаа`);
      await safe('gmail', autoGmailSync);
      // #124-9: падаанд ороогүй нэмэлт барааны хүсэлт өдөр дуусахад цуцлагдана
      const exp = await safe('extra', expireExtraRequests);
      if (exp) console.log(`[jobs] нэмэлт барааны хүсэлт автоматаар цуцлагдсан: ${exp}`);
      const hb = JSON.stringify({ at: new Date().toISOString(), failed });
      await db.$executeRaw`INSERT INTO "AppSetting" (key, value, "updatedAt") VALUES (${HEARTBEAT_KEY}, ${hb}::jsonb, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`;
      hbCache = null;
      return { ran: true, cancelled: cancelled ?? 0, meta: meta ?? { sent: 0, failed: 0 }, reconciled: !!rec, failed };
    } finally {
      await releaseLease(owner).catch((e) => console.error('[jobs] lease', (e as Error).message));
    }
  } finally {
    running = false;
  }
}

let hbCache: { at: number; v: { at: string; failed?: string[] } | null } | null = null;
/** Супер админд: арын ажил JOBS_STALE_MS-ээс удаан ажиллаагүй (анх суулгаад нэг ч удаа ажиллаагүй бол анхааруулахгүй) */
export async function jobsAlert(roles: string[]): Promise<{ at: string } | null> {
  if (!roles.includes('SUPER_ADMIN')) return null;
  if (!hbCache || Date.now() - hbCache.at > 30_000) {
    const row = await db.appSetting.findUnique({ where: { key: HEARTBEAT_KEY } });
    hbCache = { at: Date.now(), v: (row?.value ?? null) as { at: string } | null };
  }
  const v = hbCache.v;
  if (v && Date.now() - Date.parse(v.at) > JOBS_STALE_MS) return { at: v.at };
  return null;
}

let started = false;
export function startJobs() {
  if (started || process.env.DISABLE_JOBS === '1') return;
  started = true;
  const tick = () => runJobsOnce().catch((e) => console.error('[jobs]', (e as Error).message));
  setTimeout(tick, 15_000);
  // #126: өмнө нь танигдаагүй (зай/зураастай утастай) гүйлгээг нэг удаа дахин тааруулна
  setTimeout(() => rescanUnmatched().then((r) => { if (r.phones) console.log(`[jobs] банк дахин уншсан: утас ${r.phones}, таарсан ${r.matched}`); }).catch((e) => console.error('[jobs] bank rescan', (e as Error).message)), 20_000);
  setInterval(tick, 60_000).unref?.();
}

/** Тестэд: процессуудын хоорондох ээлжийг шууд шалгах */
export const _lease = { acquire: acquireLease, release: releaseLease, LEASE_MS, bust: () => { hbCache = null; } };
