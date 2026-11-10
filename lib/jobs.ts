import { db } from './db';
import { autoCancelExpired } from './services/orders/orders';
import { processMetaQueue } from './services/orders/meta';

/**
 * Арын ажил (минут тутам): Meta Purchase илгээх / дахин оролдох, хугацаа нь дууссан «Төлбөр хүлээж буй» захиалгыг цуцлах.
 * Олон апп (replica) ажилласан ч advisory lock-оор нэг л нь гүйцэтгэнэ.
 */
export async function runJobsOnce(): Promise<{ ran: boolean; cancelled?: number; meta?: { sent: number; failed: number } }> {
  const got = await db.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(42::int4, 1::int4) AS ok`;
  if (!got[0]?.ok) return { ran: false };
  try {
    const cancelled = await autoCancelExpired();
    const meta = await processMetaQueue();
    return { ran: true, cancelled, meta };
  } finally {
    await db.$queryRaw`SELECT pg_advisory_unlock(42::int4, 1::int4)`;
  }
}

let started = false;
export function startJobs() {
  if (started || process.env.DISABLE_JOBS === '1') return;
  started = true;
  const tick = () => runJobsOnce().catch((e) => console.error('[jobs]', (e as Error).message));
  setTimeout(tick, 15_000);
  setInterval(tick, 60_000).unref?.();
}
