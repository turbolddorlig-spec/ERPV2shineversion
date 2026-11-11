'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';

/** Жолоочийн хяналт (Модуль 5): өдөр, жолооч бүрээр — зөвхөн харах. Мөнгөний тооцоо Модуль 6 */
interface Row { id: string; name: string; phone: string; assigned: number; out: number; delivered: number; partial: number; cancelled: number; postponed: number; goods: number; returnable: number; lastReturnAt: string | null; cash: number; bank: number; unpaid: number; prepaid: number; deliveredSum: number; extraSales: number }
interface Resp { date: string; items: Row[]; totals: Record<string, number> }
const ubToday = (add = 0) => new Date(Date.now() + 8 * 3600_000 + add * 86_400_000).toISOString().slice(0, 10);

export function DriverControlClient() {
  const [date, setDate] = useState(ubToday());
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { try { setData(await api(`/api/driver-control?date=${date}`)); setErr(null); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Алдаа гарлаа'); } }, [date]);
  useEffect(() => { void load(); }, [load]);
  const t = data?.totals;
  const th = 'px-2.5 py-2 text-right font-bold whitespace-nowrap';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-[24px] font-extrabold tracking-tight">Жолоочийн хяналт</h1><p className="text-[13.5px] text-muted">Хүргэсэн, цуцалсан, хойшилсон — тухайн өдрөөр; гарт байгаа бараа — одоогийн</p></div>
        <div className="flex items-center gap-2">
          {[[-1, 'Өчигдөр'], [0, 'Өнөөдөр']].map(([a, l]) => <button key={l} onClick={() => setDate(ubToday(Number(a)))} className={clsx('h-10 rounded-full border px-3.5 text-[13px] font-bold', date === ubToday(Number(a)) ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>{l}</button>)}
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-10 rounded-[10px] border border-line bg-surface px-2 text-[14px]" aria-label="Огноо" />
        </div>
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {t ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {([['Оноосон', t.assigned], ['Хүргэлтэд', t.out], ['Хүргэсэн', t.delivered], ['Цуцалсан', t.cancelled], ['Маргааш', t.postponed], ['Гарт (ш)', t.goods], ['Буцаах (ш)', t.returnable], ['Бэлэн', money(t.cash)]] as const).map(([l, v]) => (
            <div key={l} className="rounded-[12px] border border-line bg-surface px-3 py-2"><div className="text-[11.5px] font-semibold text-subtle">{l}</div><div className="text-[18px] font-extrabold">{v}</div></div>
          ))}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-[16px] border border-line bg-surface shadow-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-[13px]">
            <thead className="bg-surface2 text-[12px] text-muted"><tr>
              <th className="px-3 py-2 text-left font-bold">Жолооч</th><th className={th}>Оноосон</th><th className={th}>Хүргэлтэд</th><th className={th}>Хүргэсэн</th><th className={th}>Цуцалсан</th><th className={th}>Маргааш</th>
              <th className={th}>Гарт</th><th className={th}>Буцаах</th><th className={th}>Бэлэн</th><th className={th}>Данс</th><th className={th}>Өр</th><th className={th}>Нэмэлт</th><th className="px-3 py-2 text-left font-bold">Сүүлийн буцаалт</th>
            </tr></thead>
            <tbody className="divide-y divide-line">
              {data?.items.map((r) => (
                <tr key={r.id} className="hover:bg-surface2/50">
                  <td className="max-w-[220px] px-3 py-2"><b className="block [overflow-wrap:anywhere]">{r.name}</b><span className="text-[12px] text-subtle">{r.phone}</span></td>
                  <td className="px-2.5 py-2 text-right">{r.assigned || ''}</td>
                  <td className="px-2.5 py-2 text-right text-info">{r.out || ''}</td>
                  <td className="px-2.5 py-2 text-right font-bold text-ok-ink">{r.delivered || ''}{r.partial ? <span className="block text-[11px] font-semibold text-warn">хэсэгчилсэн {r.partial}</span> : null}</td>
                  <td className="px-2.5 py-2 text-right text-bad-ink">{r.cancelled || ''}</td>
                  <td className="px-2.5 py-2 text-right text-warn">{r.postponed || ''}</td>
                  <td className="px-2.5 py-2 text-right">{r.goods || ''}</td>
                  <td className={clsx('px-2.5 py-2 text-right', r.returnable && 'font-extrabold text-warn')}>{r.returnable ? <Link href="/handover/returns" className="underline decoration-dotted">{r.returnable}</Link> : ''}</td>
                  <td className="px-2.5 py-2 text-right">{r.cash ? money(r.cash) : ''}</td>
                  <td className="px-2.5 py-2 text-right">{r.bank ? money(r.bank) : ''}</td>
                  <td className="px-2.5 py-2 text-right text-bad-ink">{r.unpaid ? money(r.unpaid) : ''}</td>
                  <td className="px-2.5 py-2 text-right">{r.extraSales ? money(r.extraSales) : ''}</td>
                  <td className="px-3 py-2 text-[12px] text-subtle">{r.lastReturnAt ? ubDateTime(r.lastReturnAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && !data.items.length ? <p className="px-4 py-10 text-center text-muted">Энэ өдөр жолоочийн ажил алга</p> : null}
      </div>
    </div>
  );
}
