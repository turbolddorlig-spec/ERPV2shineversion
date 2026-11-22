'use client';
import clsx from 'clsx';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { PageBand } from '@/components/shell/AppShell';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';
import { PlanLine, ReorderDialog, type ReorderPlan } from './OutflowClient';

type Level = 'URGENT' | 'ORDER' | 'LATE' | 'ORDERED' | 'OK';
interface Ord { id: number; qty: number; expectedDay: string; byName: string; note: string; variantId: number | null }
interface Row {
  id: number; code: string; name: string; thumb: string | null; level: Level; available: number; pace: number; days: number | null; runOutDay: string | null; worstLabel: string | null; order: Ord | null; plan?: ReorderPlan | null;
  variants: { variantId: number; label: string; available: number; pace: number; days: number | null; level: Level; order: Ord | null; plan?: ReorderPlan | null }[];
}
interface Resp { tab: string; page: number; total: number; pages: number; counts: { need: number; ordered: number }; rows: Row[] }
const LV: Record<Level, { l: string; cls: string }> = {
  URGENT: { l: '🔴 Яаралтай', cls: 'bg-bad-soft text-bad-ink' },
  LATE: { l: '⏰ Хоцорсон', cls: 'bg-bad-soft text-bad-ink' },
  ORDER: { l: '🟠 Татах', cls: 'bg-warn-soft text-warn' }, // #205: захиалсан ч дахин татах цаг болсон бол мөн «Татах»
  ORDERED: { l: '🚚 Захиалсан', cls: 'bg-info-soft text-info' },
  OK: { l: 'Хангалттай', cls: 'bg-surface2 text-muted' },
};
const md = (d: string) => d.slice(5).replace('-', '/');
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');

/** #174 «Бараа татах» — бараа захиалгын ажилтан: дуусах дөхсөн бараа, нөөц хоног, «Захиалсан» тэмдэглэх. Мөнгөн дүнгүй. */
export function ReorderClient() {
  const [tab, setTab] = useState<'need' | 'ordered' | 'all'>('need');
  const [q, setQ] = useState(''); const [qd, setQd] = useState('');
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [dlg, setDlg] = useState<{ id: number; name: string; code: string } | null>(null);
  useEffect(() => { const t = setTimeout(() => { setQd(q); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const load = useCallback(async () => {
    try { setD(await api<Resp>(`/api/reorder?${new URLSearchParams({ tab, page: String(page), ...(qd ? { q: qd } : {}) })}`)); setErr(null); } catch (e) { setErr(msg(e)); }
  }, [tab, page, qd]);
  useEffect(() => { void load(); }, [load]);
  const post = async (json: Record<string, unknown>, m?: string) => {
    try { const r = await api('/api/reorder', { method: 'POST', json }); if (m) setOk(m); await load(); return r; } catch (e) { setErr(msg(e)); return null; }
  };
  const toggle = (id: number) => { const n = new Set(open); if (n.has(id)) n.delete(id); else n.add(id); setOpen(n); };
  const cover = (days: number | null, level: Level, order: Ord | null) => (
    <span className={clsx('inline-flex min-w-[88px] flex-col items-center rounded-lg px-1.5 py-0.5 leading-tight', LV[level].cls)}>
      <b className="text-[12.5px]">{days === null ? '∞' : `${days} хоног`}</b>
      <span className="text-[10.5px]">{order ? `🚚 ${order.qty}ш · ${md(order.expectedDay)}` : LV[level].l}</span>
    </span>
  );
  return (
    <div className="flex flex-col gap-4">
      <PageBand title="Бараа татах" subtitle="Дуусах дөхсөн бараа — нөөц хоног = боломжтой ÷ өдрийн хурд. Нийлүүлэгчээс захиалсны дараа «Захиалсан» тэмдэглэнэ; орлого ормогц автоматаар хаагдана." />
      {err ? <Notice>{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
      <div className="flex flex-wrap items-center gap-2">
        {([['need', `Татах${d ? ` (${d.counts.need})` : ''}`], ['ordered', `Захиалсан${d ? ` (${d.counts.ordered})` : ''}`], ['all', 'Бүгд']] as const).map(([k, l]) => (
          <button key={k} type="button" onClick={() => { setTab(k); setPage(1); }} className={clsx('h-9 rounded-full border px-3.5 text-[13px] font-bold', tab === k ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-muted')}>{l}</button>
        ))}
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Нэр, код…" aria-label="Хайх" className="h-9 min-w-[180px] flex-1 rounded-[10px] border border-line bg-surface px-3 text-[13.5px]" />
      </div>
      <div className="overflow-hidden rounded-[16px] border border-line bg-surface shadow-card">
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-[13px]">
          <thead className="bg-surface2 text-[12px] text-muted"><tr><th className="px-3 py-2 text-left">Бараа</th><th className="px-3 py-2 text-right">Боломжтой</th><th className="px-3 py-2 text-right">Өдөрт</th><th className="px-3 py-2 text-center">Нөөц</th><th className="px-3 py-2 text-right" /></tr></thead>
          <tbody>
            {d?.rows.map((r) => (
              <Fragment key={r.id}>
                <tr data-reorder-row={r.id} className="border-t border-line align-middle">
                  <td className="max-w-[340px] px-3 py-2">
                    <div className="flex items-center gap-2">
                      {r.variants.length > 1 ? <button type="button" aria-label={`${r.name} өнгөөр`} aria-expanded={open.has(r.id)} onClick={() => toggle(r.id)} className="h-6 w-6 shrink-0 rounded text-muted hover:bg-surface2">{open.has(r.id) ? '▾' : '▸'}</button> : <span className="w-6 shrink-0" />}
                      {r.thumb ? <img src={r.thumb} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" /> : <span className="h-9 w-9 shrink-0 rounded-lg bg-surface2" />}
                      <div className="min-w-0"><div className="line-clamp-2 font-semibold [overflow-wrap:anywhere]">{r.name}</div><div className="text-[11.5px] text-muted [overflow-wrap:anywhere]">{r.code}{r.worstLabel ? ` · хамгийн дутуу: ${r.worstLabel}` : ''}</div>{r.plan ? <PlanLine p={r.plan} compact /> : null}</div>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-bold">{r.available}</td>
                  <td className="px-3 py-2 text-right">{r.pace}</td>
                  <td className="px-3 py-2 text-center">{cover(r.days, r.level, r.order)}</td>
                  <td className="px-3 py-2 text-right"><Button size="sm" variant={r.order ? 'secondary' : 'primary'} onClick={() => setDlg({ id: r.id, name: r.name, code: r.code })}>{r.order ? 'Дэлгэрэнгүй' : '🚚 Захиалсан гэж тэмдэглэх'}</Button></td>
                </tr>
                {open.has(r.id) ? r.variants.map((v) => (
                  <tr key={v.variantId} data-reorder-variant className="border-t border-line/60 bg-surface2/50 text-[12.5px]">
                    <td className="py-1.5 pl-14 pr-3 [overflow-wrap:anywhere]">↳ <b>{v.label}</b>{v.plan ? <PlanLine p={v.plan} compact /> : null}</td>
                    <td className="px-3 py-1.5 text-right font-semibold">{v.available}</td>
                    <td className="px-3 py-1.5 text-right">{v.pace}</td>
                    <td className="px-3 py-1.5 text-center">{cover(v.days, v.level, v.order)}</td>
                    <td />
                  </tr>
                )) : null}
              </Fragment>
            ))}
          </tbody>
        </table></div>
        {d && !d.rows.length ? <p className="px-4 py-10 text-center text-muted">{tab === 'need' ? 'Татах шаардлагатай бараа алга ✓' : 'Жагсаалт хоосон'}</p> : null}
        {d && d.pages > 1 ? (
          <div className="flex items-center justify-between border-t border-line px-3 py-2 text-[13px]"><span className="text-muted">{d.total} бараа</span>
            <div className="flex items-center gap-2"><Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</Button><span>{page} / {d.pages}</span><Button size="sm" disabled={page >= d.pages} onClick={() => setPage(page + 1)}>›</Button></div></div>
        ) : null}
      </div>
      {dlg ? <ReorderDialog row={dlg} sub="бараа татах" detailUrl={`/api/reorder?view=detail&id=${dlg.id}`} onClose={() => { setDlg(null); void load(); }} post={post} /> : null}
    </div>
  );
}
