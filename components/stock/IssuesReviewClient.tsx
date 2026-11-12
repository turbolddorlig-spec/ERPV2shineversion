'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Badge } from '@/components/ui/Badge';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';

interface Item {
  id: number; warehouse: string; reasonLabel: string; note: string; createdByName: string; createdAt: string; reviewedAt: string | null; reviewedByName: string | null;
  lines: { variantId: number; qty: number; code?: string; name?: string; label?: string; unitPrice: number }[]; pieces: number; value: number;
}
interface Resp { status: string; page: number; hasMore: boolean; pendingCount: number; items: Item[] }
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');

/** Аудит #143: «Зарлага хянах» — хянаагүй зарлага үнийн дүнтэй; сонгоод «Шалгасан» */
export function IssuesReviewClient() {
  const [status, setStatus] = useState<'pending' | 'reviewed' | 'all'>('pending');
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Resp | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setD(await api<Resp>(`/api/stock/issues?status=${status}&page=${page}`)); setErr(null); } catch (e) { setErr(msg(e)); }
  }, [status, page]);
  useEffect(() => { void load(); }, [load]);
  const review = async (ids: number[]) => {
    setBusy(true); setErr(null);
    try { await api('/api/stock/issues', { method: 'POST', json: { action: 'review', ids } }); setSel(new Set()); await load(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const pend = d?.items.filter((i) => !i.reviewedAt) ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {([['pending', `Хянаагүй${d ? ` (${d.pendingCount})` : ''}`], ['reviewed', 'Шалгасан'], ['all', 'Бүгд']] as const).map(([k, l]) => (
          <button key={k} type="button" onClick={() => { setStatus(k); setPage(1); setSel(new Set()); }}
            className={clsx('h-9 rounded-full border px-3.5 text-[13px] font-semibold', status === k ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface hover:bg-surface2')}>{l}</button>
        ))}
        {pend.length ? <Button size="sm" variant="primary" className="ml-auto" loading={busy} disabled={!sel.size} onClick={() => void review([...sel])}>Сонгосныг «Шалгасан» ({sel.size})</Button> : null}
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {d && !d.items.length ? <p className="text-muted">Зарлага алга.</p> : null}
      <ul className="flex flex-col gap-2">
        {d?.items.map((i) => (
          <li key={i.id} className={clsx('flex min-w-0 flex-col gap-1.5 rounded-xl border p-3 text-[13px]', i.reviewedAt ? 'border-line' : 'border-warn/50 bg-warn-soft/30')}>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {!i.reviewedAt ? <input type="checkbox" aria-label={`Зарлага №${i.id} сонгох`} className="h-5 w-5" checked={sel.has(i.id)} onChange={(e) => { const s = new Set(sel); if (e.target.checked) s.add(i.id); else s.delete(i.id); setSel(s); }} /> : null}
              <b>№{i.id}</b><Badge tone="warn">{i.reasonLabel}</Badge>
              <span className="text-muted">{i.warehouse} · {i.createdByName} · {ubDateTime(i.createdAt)}</span>
              <b className="ml-auto whitespace-nowrap text-[14px]">{i.pieces} ш · {money(i.value)}</b>
            </div>
            <div className="min-w-0 [overflow-wrap:anywhere]"><span className="text-subtle">Тайлбар:</span> {i.note}</div>
            <div className="min-w-0 text-muted [overflow-wrap:anywhere]">{i.lines.map((l) => `${l.code ?? ''} ${l.name ?? `#${l.variantId}`}${l.label ? ` · ${l.label}` : ''} ${l.qty}ш × ${money(l.unitPrice)}`).join('; ')}</div>
            <div className="flex flex-wrap items-center gap-2">
              {i.reviewedAt ? <Badge tone="ok">✓ Шалгасан · {i.reviewedByName} · {ubDateTime(i.reviewedAt)}</Badge>
                : <Button size="sm" loading={busy} onClick={() => void review([i.id])}>Шалгасан</Button>}
            </div>
          </li>
        ))}
      </ul>
      {d && (page > 1 || d.hasMore) ? (
        <div className="flex items-center justify-center gap-2">
          <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Өмнөх</Button>
          <span className="text-[13px] text-muted">{page}-р хуудас</span>
          <Button size="sm" disabled={!d.hasMore} onClick={() => setPage(page + 1)}>Дараах →</Button>
        </div>
      ) : null}
    </div>
  );
}
