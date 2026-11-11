import { db } from './db';
import { autoCancelExpired } from './services/orders/orders';
import { processMetaQueue } from './services/orders/meta';
import { autoReconcile } from './services/stock/views';
import { closeDayShortages } from './services/accounting/debts';
import { autoGmailSync } from './services/accounting/gmail';
import { expireExtraRequests } from './services/delivery/goods';

/**
 * Арын ажил (минут тутам): Meta Purchase илгээх / дахин оролдох, хугацаа нь дууссан «Төлбөр хүлээж буй» захиалгыг цуцлах,
 * цаг тутам үлдэгдлийн тулгалт (журнал = үлдэгдэл, B2/R2).
 * Олон апп (replica) ажилласан ч advisory lock-оор нэг л нь гүйцэтгэнэ.
 */
export async function runJobsOnce(): Promise<{ ran: boolean; cancelled?: number; meta?: { sent: number; failed: number }; reconciled?: boolean }> {
  const got = await db.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(42::int4, 1::int4) AS ok`;
  if (!got[0]?.ok) return { ran: false };
  try {
    const cancelled = await autoCancelExpired();
    const meta = await processMetaQueue();
    const rec = await autoReconcile().catch((e) => { console.error('[jobs] reconcile', (e as Error).message); return null; });
    if (rec && !rec.ok) console.error(`[jobs] ҮЛДЭГДЛИЙН ЗӨРҮҮ: ${rec.count}`);
    // Модуль 6: өдрийн эцэст жолоочид буцаагаагүй бараа → автомат өр (өдөрт нэг удаа); Gmail автомат sync
    const shortage = await closeDayShortages().catch((e) => { console.error('[jobs] shortage', (e as Error).message); return null; });
    if (shortage?.ran) console.log(`[jobs] дутуу барааны өр ${shortage.date}: +${shortage.created} ~${shortage.changed} ✓${shortage.resolved}`);
    await autoGmailSync().catch((e) => console.error('[jobs] gmail', (e as Error).message));
    // #124-9: падаанд ороогүй нэмэлт барааны хүсэлт өдөр дуусахад цуцлагдана
    const exp = await expireExtraRequests().catch((e) => { console.error('[jobs] extra', (e as Error).message); return 0; });
    if (exp) console.log(`[jobs] нэмэлт барааны хүсэлт автоматаар цуцлагдсан: ${exp}`);
    return { ran: true, cancelled, meta, reconciled: !!rec };
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
