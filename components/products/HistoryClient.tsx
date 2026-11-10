'use client';
import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { HistoryCard, type HistoryResp } from './ProductHistoryList';

export function HistoryClient({ selfId, canReview, superAdmin = false }: { selfId: string; canReview: boolean; superAdmin?: boolean }) {
  const router = useRouter();
  const [confirmAll, setConfirmAll] = useState(false);
  const [allBusy, setAllBusy] = useState(false);
  const initial = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const [productId] = useState(initial?.get('productId') ?? '');
  const [actor, setActor] = useState<{ id: string; name: string } | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [important, setImportant] = useState(false);
  const [unreviewed, setUnreviewed] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<HistoryResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    const sp = new URLSearchParams({ page: String(page) });
    if (productId) sp.set('productId', productId);
    if (actor) sp.set('actorId', actor.id);
    if (from) sp.set('from', from);
    if (to) sp.set('to', to);
    if (important) sp.set('important', '1');
    if (unreviewed) sp.set('unreviewed', '1');
    try {
      const r = await api<HistoryResp>(`/api/products/history?${sp}`);
      if (id === reqId.current) { setData(r); setError(null); }
    } catch (e) { if (id === reqId.current) setError(e instanceof ApiError ? e.message : 'Ачаалж чадсангүй'); }
  }, [productId, actor, from, to, important, unreviewed, page]);
  useEffect(() => { load(); }, [load]);

  /** Шалгасны дараа жагсаалт болон цэсний тэмдэгтийг шинэчилнэ */
  const afterReview = useCallback(() => { load(); router.refresh(); }, [load, router]);

  async function reviewAll() {
    setAllBusy(true);
    try { await api('/api/products/history/review-all', { method: 'POST', json: {} }); setConfirmAll(false); afterReview(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Алдаа гарлаа'); }
    finally { setAllBusy(false); }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const chip = (on: boolean) => clsx('h-10 shrink-0 rounded-full border px-4 text-[13.5px] font-semibold', on ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-ink');

  return (
    <div className="flex flex-col gap-4">
      {canReview && data && data.unreviewed > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warn-soft px-3.5 py-3 text-warn">
          <strong className="text-[15px]">{data.unreviewed} засвар шалгагдаагүй байна</strong>
          <Button size="sm" onClick={() => { setUnreviewed(true); setPage(1); }}>Харах</Button>
          {superAdmin ? (confirmAll ? (
            <span className="flex flex-wrap items-center gap-2 sm:ml-auto">
              <span className="text-[13.5px] font-semibold">{data.unreviewed} засварыг бүгдийг шалгасан болгох уу?</span>
              <Button size="sm" variant="dark" loading={allBusy} onClick={reviewAll}>Тийм</Button>
              <Button size="sm" onClick={() => setConfirmAll(false)}>Үгүй</Button>
            </span>
          ) : (
            <Button size="sm" variant="dark" className="sm:ml-auto" onClick={() => setConfirmAll(true)}>
              <Icon name="check" size={15} /> Бүгдийг шалгасан болгох
            </Button>
          )) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <button type="button" aria-pressed={important} onClick={() => { setImportant(!important); setPage(1); }} className={chip(important)}>Зөвхөн чухал (үнэ, код, төлөв)</button>
        <button type="button" aria-pressed={unreviewed} onClick={() => { setUnreviewed(!unreviewed); setPage(1); }} className={chip(unreviewed)}>Шалгаагүй</button>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-muted">Эхлэх<input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="h-10 rounded-xl border border-line bg-surface px-2 text-ink" /></label>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-muted">Дуусах<input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="h-10 rounded-xl border border-line bg-surface px-2 text-ink" /></label>
        {actor ? <button type="button" onClick={() => { setActor(null); setPage(1); }} className="inline-flex h-10 items-center gap-2 rounded-full bg-accent-soft px-4 text-[13.5px] font-bold text-accent-ink">{actor.name}<Icon name="close" size={14} /></button> : null}
        {productId ? <a href="/products/history" className="inline-flex h-10 items-center gap-2 rounded-full bg-accent-soft px-4 text-[13.5px] font-bold text-accent-ink">Нэг бараа<Icon name="close" size={14} /></a> : null}
      </div>
      {error ? <Notice>{error}</Notice> : null}
      {data ? (
        <>
          <p className="text-[13px] text-muted">{data.total.toLocaleString('en-US')} бичлэг{actor ? ` · ${actor.name}` : ''}</p>
          <ul className="flex flex-col gap-2.5">
            {data.items.map((i) => (
              <HistoryCard key={i.id} item={i} canReview={canReview} selfId={selfId} allowSelf={superAdmin} onReviewed={afterReview} onActor={(id, name) => { setActor({ id, name }); setPage(1); }} />
            ))}
          </ul>
          {data.items.length === 0 ? <div className="rounded-[16px] border border-dashed border-line bg-surface p-8 text-center text-muted">Бичлэг алга</div> : null}
          {data.total > data.pageSize ? (
            <div className="flex items-center justify-between text-[13.5px] text-muted">
              <span>{page} / {pages}</span>
              <div className="flex gap-2">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Өмнөх</Button>
                <Button size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Дараах</Button>
              </div>
            </div>
          ) : null}
        </>
      ) : <p className="text-muted">Ачаалж байна…</p>}
    </div>
  );
}
