'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { api } from '@/components/ui/api';
import { money } from '@/lib/format';
import { PenaltyList, msg, type PenaltyRow, type Summary } from './PenaltiesClient';

/** Миний торгууль (Модуль 7а): зөвхөн өөрийнх — нийт, цалингаас хассан, хасагдаагүй; огноо, төлөвөөр */
export function MyPenaltiesClient() {
  const [range, setRange] = useState<'month' | 'all'>('month');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [d, setD] = useState<{ page: number; pages: number; total: number; summary: Summary; items: PenaltyRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const from = range === 'month' ? `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 8)}01` : '';
    try { setD(await api(`/api/my-penalties?${new URLSearchParams({ ...(from ? { from } : {}), ...(status ? { status } : {}), page: String(page) })}`)); setErr(null); } catch (e) { setErr(msg(e)); }
  }, [range, status, page]);
  useEffect(() => { void load(); }, [load]);
  const s = d?.summary;
  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
      <h1 className="text-[24px] font-extrabold tracking-tight">Миний торгууль</h1>
      <div className="flex flex-wrap gap-2">
        {([['month', 'Энэ сар'], ['all', 'Бүгд']] as const).map(([k, l]) => <button key={k} onClick={() => { setRange(k); setPage(1); }} className={clsx('h-10 rounded-full px-4 text-[13.5px] font-bold', range === k ? 'bg-ink text-on-ink' : 'border border-line bg-surface text-muted')}>{l}</button>)}
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="h-10 rounded-full border border-line bg-surface px-3 text-[13.5px]" aria-label="Төлөв">
          <option value="">Бүх төлөв</option><option value="PENDING">Хасагдаагүй</option><option value="DEDUCTED">Цалингаас хассан</option><option value="CANCELLED">Цуцлагдсан</option>
        </select>
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {s ? (
        <div className="grid grid-cols-3 gap-2">
          {([['Нийт', money(s.total), `${s.count} удаа`, null], ['Хасагдаагүй', money(s.pending), 'цалингаас хасагдана', 'bad'], ['Цалингаас хассан', money(s.deducted), null, 'ok']] as const).map(([l, v, sub, t]) => (
            <div key={l} className="min-w-0 rounded-[16px] border border-line bg-surface px-3 py-2.5"><div className="text-[12px] font-semibold text-muted">{l}</div><div className={clsx('truncate text-[19px] font-extrabold', t === 'bad' && 'text-bad-ink', t === 'ok' && 'text-ok-ink')}>{v}</div>{sub ? <div className="truncate text-[11.5px] text-subtle">{sub}</div> : null}</div>
          ))}
        </div>
      ) : null}
      <PenaltyList items={d?.items ?? []} />
      {d && d.pages > 1 ? <div className="flex items-center justify-end gap-2 text-[13px]"><Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</Button><span>{page} / {d.pages}</span><Button size="sm" disabled={page >= d.pages} onClick={() => setPage(page + 1)}>›</Button></div> : null}
    </div>
  );
}
