'use client';
import clsx from 'clsx';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Badge } from '@/components/ui/Badge';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';

/**
 * Барааны гарц (Модуль 7г): 7 хоногийн гарц (захиалгын өдрөөр, өдөр дуусахад бэхлэгдэнэ), $/Бүүст/AD, хариуцагч, «Хийсэн ✓»,
 * бүүстийн анхааруулга (🔴 / 🟠 / 👁 / 💎), ажлын цонх, өөрийн ажил, пэйж, статистик, үнэлгээ, ашгийн задаргаа (Супер админ).
 */
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const ubToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const shiftDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const digits = (s: string) => s.replace(/\D/g, '').slice(0, 7);
const inputCls = 'h-10 min-w-0 rounded-[10px] border border-line bg-surface px-2.5 text-[13.5px]';
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

type Status = 'DIAMOND' | 'GOOD' | 'LOW' | 'LOSS';
const STATUS: Record<Status, { icon: string; label: string; cls: string }> = {
  DIAMOND: { icon: '💎', label: 'Зорилт 150%+', cls: 'text-info' }, GOOD: { icon: '🟢', label: 'Зорилт хангасан', cls: 'text-ok-ink' },
  LOW: { icon: '🟠', label: 'Зорилт 80–99%', cls: 'text-warn' }, LOSS: { icon: '🔴', label: 'Зорилт хангаагүй', cls: 'text-bad-ink' },
};
interface Row {
  id: number; code: string; name: string; price: number; dollar: number; zones: number; adNumber: number | null; ownerId: string | null; ownerName: string | null;
  doneAt: string | null; doneByName: string | null; note: string; daily: number[]; weekTotal: number; avg: number; phones: number[]; phoneWeek: number; variantCount: number; bulk: { n: number; qty: number }[];
  stock?: { total: number; available: number; driver: number }; alert?: 'RED' | 'ORANGE' | null; profit?: { status: Status | null; perUnit: number | null; orders: number; target: number } | null;
  alertInfo?: { level: 'RED' | 'ORANGE'; reasons: string[]; pages: { name: string; n: number }[]; watchedUntil: string | null; watchedBy: string | null } | null;
  reorder?: Reorder | null;
}
type RLevel = 'OK' | 'ORDER' | 'URGENT' | 'ORDERED' | 'LATE';
interface Reorder {
  productId: number; available: number; pace: number; days: number | null; runOutDay: string | null; level: RLevel;
  basis: { avg7: number; avg3: number; today: number; fullDays: number };
  order: { id: number; qty: number; expectedDay: string; orderedAt: string; byName: string; note: string; variantId: number | null } | null;
  worstLabel: string | null;
  variants: { variantId: number; label: string; available: number; pace: number; days: number | null; runOutDay: string | null; level: RLevel; order: Reorder['order'] }[];
}
interface Table {
  rows: Row[]; total: number; page: number; pages: number; days: string[]; counts: { all: number; boost: number; noboost: number; red: number; orange: number; watched: number; pageShort: number; reorder?: number; ordered?: number };
  totals: { today: number; yesterday: number }; dollars: number[]; owners: { id: string; name: string }[]; isLead: boolean; isSA: boolean;
}

/** Нүдний өнгө: бүүстэй — бүс × $ босго; бүүстгүй — дунджийн харьцаа (хуучин шиг) */
function cellCls(v0: number, r: Row, i = -1) {
  // Бөөний захиалгыг өнгөнд тооцохгүй (#117)
  const v = i >= 0 ? v0 - (r.bulk?.[i]?.qty ?? 0) : v0;
  if (r.zones > 0) { const t = r.zones * (r.dollar || 5); return v >= t ? 'bg-ok-soft text-ok-ink' : v === 0 ? 'text-subtle' : 'bg-bad-soft text-bad-ink'; }
  if (v === 0) return 'text-subtle';
  const k = r.avg > 0 ? v / r.avg : 0;
  return k >= 2 ? 'bg-ok-soft text-ok-ink font-bold' : k >= 1 ? 'bg-ok-soft text-ok-ink' : k >= 0.7 ? 'bg-warn-soft text-warn' : k >= 0.4 ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad-ink';
}

export function OutflowClient() {
  const sp = useSearchParams();
  const [tab, setTab] = useState(sp.get('tab') ?? 'all');
  const [q, setQ] = useState(''); const [qd, setQd] = useState('');
  const [zone, setZone] = useState(''); const [owner, setOwner] = useState(''); const [dollar, setDollar] = useState(''); const [status, setStatus] = useState('');
  const [sort, setSort] = useState('week'); const [dir, setDir] = useState<'asc' | 'desc'>('desc'); const [page, setPage] = useState(1);
  const [d, setD] = useState<Table | null>(null);
  const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [dlg, setDlg] = useState<null | { k: 'alert'; row: Row } | { k: 'reorder'; row: Row } | { k: 'edit'; row: Row } | { k: 'profit'; id: number } | { k: 'bulk'; ids: number[] } | { k: 'pages' | 'stats' | 'work' | 'my' | 'eval' | 'config' | 'pageshort' }>(sp.get('dlg') === 'pageshort' ? { k: 'pageshort' } : null);
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (id: number) => { const n = new Set(open); if (n.has(id)) n.delete(id); else n.add(id); setOpen(n); };
  const [hover, setHover] = useState<{ id: number; x: number; y: number } | null>(null);
  useEffect(() => { const t = setTimeout(() => setQd(q), 300); return () => clearTimeout(t); }, [q]);
  const params = useMemo(() => new URLSearchParams({ tab, q: qd, zone, owner, dollar, status, sort, dir, page: String(page) }).toString(), [tab, qd, zone, owner, dollar, status, sort, dir, page]);
  const load = useCallback(async () => {
    try {
      setD(await api<Table>(`/api/goods-outflow?view=table&${params}`)); setErr(null);
    } catch (e) { setErr(msg(e)); }
  }, [params]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setInterval(() => void load(), 120_000); return () => clearInterval(t); }, [load]);
  const post = async (json: Record<string, unknown>, m?: string) => {
    try { const r = await api<Record<string, unknown>>('/api/goods-outflow', { method: 'POST', json }); if (m) setOk(m); setErr(null); await load(); return r; } catch (e) { setErr(msg(e)); setOk(null); return null; }
  };
  const go = (t: string) => { setTab(t); setPage(1); setSel(new Set()); if (t !== 'diamond') setStatus(''); };
  const sortBy = (k: string) => { if (sort === k) setDir(dir === 'desc' ? 'asc' : 'desc'); else { setSort(k); setDir(k === 'name' ? 'asc' : 'desc'); } setPage(1); };
  const th = (k: string, l: string, extra = '') => (
    <th className={clsx('cursor-pointer select-none whitespace-nowrap px-2 py-2 text-right', extra)} onClick={() => sortBy(k)}>{l}{sort === k ? (dir === 'desc' ? ' ↓' : ' ↑') : ''}</th>
  );

  return (
    <div className="full-bleed flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[24px] font-extrabold tracking-tight">Барааны гарц</h1>
          <p className="text-[13.5px] text-muted">7 хоног · захиалгын өдрөөр (төлбөр хүлээж буй, тэр өдөртөө цуцлагдсан орохгүй) · өдрийн дундаж = 7 хоног ÷ 7</p>
          {d ? <div className="mt-2 flex flex-wrap gap-2 text-[13px]"><span className="rounded-full bg-accent-soft px-3 py-1 font-bold text-accent">Өнөөдөр {d.totals.today}</span><span className="rounded-full bg-surface2 px-3 py-1 font-semibold">Өчигдөр {d.totals.yesterday}</span></div> : null}
        </div>
        <div className="relative">
          <Button size="sm" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-label="Бусад цэс">⋯</Button>
          {menu ? (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
              <div className="absolute right-0 z-20 mt-1 flex w-[220px] flex-col rounded-[12px] border border-line bg-surface p-1 shadow-card">
                {([['my', 'Өөрийн ажил'], ['work', 'Ажлын цонх'], ['eval', 'Үнэлгээ'], ...(d?.isLead ? [['pages', 'Пэйж хувиарлах'], ['stats', 'Статистик'], ['config', 'Тохиргоо']] : [])] as ['my' | 'work' | 'eval' | 'pages' | 'stats' | 'config', string][]).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => { setMenu(false); setDlg({ k }); }} className="rounded-[9px] px-3 py-2 text-left text-[13.5px] font-semibold hover:bg-surface2">{l}</button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
      {d ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" data-alert-tab="red" onClick={() => go('red')} className={clsx('rounded-full border px-3.5 py-1.5 text-[13.5px] font-bold', tab === 'red' ? 'border-bad bg-bad text-white' : 'border-bad/40 bg-bad-soft text-bad-ink', d.counts.red > 0 && tab !== 'red' && 'animate-pulse')}>🔴 Алдагдалтай ({d.counts.red})</button>
          <button type="button" data-alert-tab="orange" onClick={() => go('orange')} className={clsx('rounded-full border px-3.5 py-1.5 text-[13.5px] font-bold', tab === 'orange' ? 'border-warn bg-warn text-white' : 'border-warn/40 bg-warn-soft text-warn')}>🟠 Ашиг бага ({d.counts.orange})</button>
          <button type="button" onClick={() => go('watched')} className={clsx('rounded-full border px-3.5 py-1.5 text-[13.5px] font-bold', tab === 'watched' ? 'border-ink bg-ink text-surface' : 'border-line bg-surface')}>👁 Ажиглаж буй ({d.counts.watched})</button>
          <button type="button" data-pageshort-btn onClick={() => setDlg({ k: 'pageshort' })} className={clsx('rounded-full border px-3.5 py-1.5 text-[13.5px] font-bold', d.counts.pageShort ? 'border-bad/40 bg-bad-soft text-bad-ink' : 'border-line bg-surface')}>⚠ Гаралтаа хангаагүй пэйж ({d.counts.pageShort})</button>
          {d.isSA ? <button type="button" onClick={() => { go('diamond'); setStatus('DIAMOND'); }} className={clsx('rounded-full border px-3.5 py-1.5 text-[13.5px] font-bold', tab === 'diamond' ? 'border-info bg-info text-white' : 'border-line bg-surface')}>💎 Зорилт 150%+</button> : null}
          {d.isSA ? <button type="button" data-reorder-tab onClick={() => go('reorder')} className={clsx('rounded-full border px-3.5 py-1.5 text-[13.5px] font-bold', tab === 'reorder' ? 'border-warn bg-warn text-white' : 'border-warn/40 bg-warn-soft text-warn')}>🚚 Бараа татах ({d.counts.reorder ?? 0})</button> : null}
          {d.isSA ? <button type="button" onClick={() => go('ordered')} className={clsx('rounded-full border px-3.5 py-1.5 text-[13.5px] font-bold', tab === 'ordered' ? 'border-ink bg-ink text-surface' : 'border-line bg-surface')}>📦 Захиалсан ({d.counts.ordered ?? 0})</button> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 overflow-x-auto rounded-xl bg-surface2 p-1">
          {([['all', `Бүгд${d ? ` (${d.counts.all})` : ''}`], ['boost', `Бүүстэй${d ? ` (${d.counts.boost})` : ''}`], ['noboost', `Бүүстгүй${d ? ` (${d.counts.noboost})` : ''}`], ['mine', 'Миний бараа']] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => go(k)} className={clsx('shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-semibold', tab === k ? 'bg-surface text-ink shadow-sm' : 'text-muted')}>{l}</button>
          ))}
        </div>
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Нэр, код" aria-label="Бараа хайх" className={clsx(inputCls, 'w-full sm:w-[200px]')} />
        <select value={zone} onChange={(e) => { setZone(e.target.value); setPage(1); }} className={inputCls} aria-label="AD"><option value="">AD бүгд</option>{[1, 2, 3, 4, 5, 6, 7, 8, 9, 99].map((n) => <option key={n} value={n}>AD{n}</option>)}</select>
        <select value={owner} onChange={(e) => { setOwner(e.target.value); setPage(1); }} className={inputCls} aria-label="Хариуцагч"><option value="">Хариуцагч бүгд</option><option value="none">Хариуцагчгүй</option>{d?.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
        <select value={dollar} onChange={(e) => { setDollar(e.target.value); setPage(1); }} className={inputCls} aria-label="$"><option value="">$ бүгд</option><option value="none">$ байхгүй</option>{d?.dollars.map((n) => <option key={n} value={n}>${n}</option>)}</select>
        {d?.isSA ? <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className={inputCls} aria-label="Зорилт"><option value="">Зорилт (өчигдөр) бүгд</option>{(Object.keys(STATUS) as Status[]).map((k) => <option key={k} value={k}>{STATUS[k].icon} {STATUS[k].label}</option>)}</select> : null}
        {d?.isLead ? (
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            {sel.size ? <Button size="sm" variant="primary" onClick={() => setDlg({ k: 'bulk', ids: [...sel] })}>Сонгосон {sel.size}-д оноох</Button> : null}
            <Button size="sm" onClick={async () => { try { const r = await api<{ ids: number[] }>(`/api/goods-outflow?view=ids&${params}`); setDlg({ k: 'bulk', ids: r.ids }); } catch (e) { setErr(msg(e)); } }}>Шүүсэн бүгдэд ({d.total}) оноох</Button>
          </div>
        ) : null}
      </div>
      {d ? (
        <>
          <div className="hidden overflow-x-auto rounded-2xl border border-line bg-surface xl:block">
            <table className="w-full min-w-[960px] text-[13px]">
              <thead><tr className="bg-surface2 text-[12px] text-muted">
                {d.isLead ? <th className="w-8 px-2"><input type="checkbox" aria-label="Бүгдийг сонгох" checked={d.rows.length > 0 && d.rows.every((r) => sel.has(r.id))} onChange={(e) => setSel(e.target.checked ? new Set(d.rows.map((r) => r.id)) : new Set())} /></th> : null}
                <th className="cursor-pointer px-2 py-2 text-left" onClick={() => sortBy('name')}>Бараа{sort === 'name' ? (dir === 'desc' ? ' ↓' : ' ↑') : ''}</th>
                <th className="px-1 py-2">$</th>{th('zones', 'Бүүст', 'text-center')}<th className="px-1 py-2">AD</th>
                {d.days.map((day, i) => th(`d${i}`, i === 0 ? 'Өнөөдөр' : md(day), 'text-center'))}
                {th('week', '7 хоног', 'text-center')}{th('avg', 'Дундаж', 'hidden min-[1360px]:table-cell')}
                <th className="px-2 py-2 text-right">Боломжтой</th>
                {d.isSA ? th('profit', 'Зорилт (өчигдөр)') : null}
                <th className="px-1.5 py-2 text-left">Хариуцагч</th><th className="px-2 py-2 text-right">⚠</th>
                {d.isSA ? th('cover', 'Нөөц', 'text-center') : null}
              </tr></thead>
              <tbody>
                {d.rows.map((r) => (<Fragment key={r.id}>
                  <tr className={clsx('border-t border-line', r.alert === 'RED' && 'shadow-[inset_3px_0_0_var(--bad)]', r.alert === 'ORANGE' && 'shadow-[inset_3px_0_0_var(--warn-ink)]')}>
                    {d.isLead ? <td className="px-2"><input type="checkbox" aria-label={`${r.name} сонгох`} checked={sel.has(r.id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(r.id); else n.delete(r.id); setSel(n); }} /></td> : null}
                    <td className="w-[160px] min-w-[160px] max-w-[160px] px-2 py-1.5" onMouseEnter={(e) => setHover({ id: r.id, x: e.clientX, y: e.clientY })} onMouseLeave={() => setHover(null)}>
                      <div className="flex items-start gap-1">
                        {r.variantCount > 1 ? <button type="button" data-variants={r.id} aria-label={`${r.name} өнгө, хэмжээгээр`} aria-expanded={open.has(r.id)} onClick={() => toggle(r.id)} className="mt-0.5 h-5 w-5 shrink-0 rounded text-[12px] text-muted hover:bg-surface2">{open.has(r.id) ? '▾' : '▸'}</button> : null}
                        <div title={r.name} className="line-clamp-2 min-w-0 [overflow-wrap:anywhere] font-semibold">{r.name}</div>
                      </div>
                      <div className="[overflow-wrap:anywhere] text-[11.5px] text-muted">{r.code} · {money(r.price)}{r.doneAt ? ` · ✓ ${r.doneByName ?? ''}` : ''}</div>
                    </td>
                    <BoostCell row={r} field="dollar" post={post} />
                    <BoostCell row={r} field="zones" post={post} />
                    <BoostCell row={r} field="adNumber" post={post} />
                    {r.daily.map((v, i) => (
                      <td key={i} className="px-0.5 py-1 text-center"><div className={clsx('mx-auto w-9 rounded-md py-0.5 font-semibold', cellCls(v, r, i))}>{v}</div>{r.bulk[i]?.n ? <div className="text-[10.5px] font-semibold text-info" title={`Бөөний захиалга: ${r.bulk[i]!.n} захиалга, ${r.bulk[i]!.qty} ширхэг — өнгө, дунджид тооцохгүй`}>📦{r.bulk[i]!.n}×{r.bulk[i]!.qty}</div> : null}{r.phones[i] ? <div className="text-[10.5px] text-warn">☎{r.phones[i]}</div> : null}</td>
                    ))}
                    <td className="px-1 py-1 text-center font-bold">{r.weekTotal}{r.phoneWeek ? <div className="text-[10.5px] font-normal text-warn">☎{r.phoneWeek}</div> : null}</td>
                    <td className="hidden px-2 py-1 text-right min-[1360px]:table-cell">{r.avg}</td>
                    <td className={clsx('px-2 py-1 text-right', (r.stock?.available ?? 0) < r.avg && 'font-bold text-bad-ink')}>{r.stock?.available ?? 0}</td>
                    {d.isSA ? <td className="px-2 py-1 text-right">{r.profit?.status ? <button type="button" onClick={() => setDlg({ k: 'profit', id: r.id })} className={clsx('font-bold underline', STATUS[r.profit.status].cls)}>{STATUS[r.profit.status].icon} {r.profit.orders}/{r.profit.target}</button> : <button type="button" onClick={() => setDlg({ k: 'profit', id: r.id })} className="text-subtle underline">задаргаа</button>}</td> : null}
                    <td className="w-[110px] min-w-[110px] max-w-[110px] px-1.5 py-1"><div className="line-clamp-1 [overflow-wrap:anywhere] text-[12.5px] font-semibold">{r.ownerName ?? '—'}</div>{r.note ? <div title={r.note} className="line-clamp-1 [overflow-wrap:anywhere] text-[11.5px] text-muted">{r.note}</div> : null}</td>
                    <td className="px-1 py-1"><div className="flex items-center justify-end gap-1"><button type="button" aria-label={`${r.name} засах`} title="Засах" onClick={() => setDlg({ k: 'edit', row: r })} className="h-8 w-8 rounded-lg border border-line bg-surface text-[14px] hover:bg-surface2">✎</button><AlertChip r={r} onOpen={() => setDlg({ k: 'alert', row: r })} /></div></td>
                    {d.isSA ? <td className="px-1 py-1 text-center"><ReorderChip r={r} onOpen={() => setDlg({ k: 'reorder', row: r })} /></td> : null}
                  </tr>
                  {open.has(r.id) ? <VariantRows id={r.id} lead={d.isLead} sa={d.isSA} cover={r.reorder?.variants} onCover={() => setDlg({ k: 'reorder', row: r })} /> : null}
                </Fragment>
                ))}
              </tbody>
            </table>
            {d.rows.length === 0 ? <p className="p-6 text-center text-[14px] text-muted">Бараа олдсонгүй</p> : null}
          </div>
          <div className="flex flex-col gap-2 xl:hidden">
            {d.rows.map((r) => (
              <div key={r.id} className={clsx('flex min-w-0 flex-col gap-2 rounded-2xl border border-line bg-surface p-3', r.alert === 'RED' && 'border-l-4 border-l-bad', r.alert === 'ORANGE' && 'border-l-4 border-l-warn')}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0"><b className="[overflow-wrap:anywhere]">{r.name}</b><div className="[overflow-wrap:anywhere] text-[12px] text-muted">{r.code} · {r.ownerName ?? 'хариуцагчгүй'}{r.doneAt ? ' · ✓' : ''}</div></div>
                  <div className="shrink-0 text-right"><b className="text-[18px]">{r.weekTotal}</b><div className="text-[11px] text-muted">7 хоног · ⌀{r.avg}</div></div>
                </div>
                <div className="grid grid-cols-7 gap-1 text-center text-[12px]">
                  {r.daily.map((v, i) => <div key={i} className={clsx('rounded-md py-1 font-semibold', cellCls(v, r, i))}><div className="text-[10px] font-normal text-muted">{i === 0 ? 'Өнөө' : md(d.days[i]!)}</div>{v}{r.bulk[i]?.n ? <div className="text-[9.5px] text-info">📦{r.bulk[i]!.qty}</div> : null}</div>)}
                </div>
                {r.variantCount > 1 ? <button type="button" onClick={() => toggle(r.id)} className="self-start text-[12.5px] font-semibold text-accent">{open.has(r.id) ? '▾ Өнгө, хэмжээ нуух' : `▸ Өнгө, хэмжээгээр (${r.variantCount})`}</button> : null}
                {open.has(r.id) ? <VariantCards id={r.id} days={d.days} /> : null}
                <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                  <span>${r.dollar} · бүүст {r.zones} · AD{r.adNumber ?? '—'}</span><span>Боломжтой {r.stock?.available ?? 0}</span>
                  {d.isSA ? (r.profit?.status ? <button type="button" onClick={() => setDlg({ k: 'profit', id: r.id })} className={clsx('font-bold underline', STATUS[r.profit.status].cls)}>{STATUS[r.profit.status].icon} {r.profit.orders}/{r.profit.target}</button>
                    : <button type="button" onClick={() => setDlg({ k: 'profit', id: r.id })} className="text-subtle underline">задаргаа</button>) : null}
                  <span className="ml-auto flex items-center gap-2">{d.isSA ? <ReorderChip r={r} onOpen={() => setDlg({ k: 'reorder', row: r })} /> : null}<AlertChip r={r} onOpen={() => setDlg({ k: 'alert', row: r })} /><Button size="sm" onClick={() => setDlg({ k: 'edit', row: r })}>Засах</Button></span>
                </div>
              </div>
            ))}
          </div>
          {d.pages > 1 ? (
            <div className="flex flex-wrap items-center justify-center gap-2 text-[13px]">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</Button>
              <span>{page} / {d.pages} · {d.total} бараа</span>
              <Button size="sm" disabled={page >= d.pages} onClick={() => setPage(page + 1)}>›</Button>
            </div>
          ) : null}
        </>
      ) : <p className="text-muted">Ачаалж байна…</p>}
      {hover ? <HoverCard id={hover.id} x={hover.x} y={hover.y} /> : null}
      {dlg?.k === 'alert' ? <AlertDialog row={dlg.row} onClose={() => setDlg(null)} post={post} /> : null}
      {dlg?.k === 'pageshort' ? <PageShortDialog onClose={() => setDlg(null)} post={post} /> : null}
      {dlg?.k === 'reorder' ? <ReorderDialog row={dlg.row} onClose={() => setDlg(null)} post={post} /> : null}
      {dlg?.k === 'edit' ? <EditDialog row={dlg.row} lead={!!d?.isLead} owners={d?.owners ?? []} onClose={() => setDlg(null)} post={post} /> : null}
      {dlg?.k === 'bulk' ? <BulkDialog ids={dlg.ids} owners={d?.owners ?? []} onClose={() => setDlg(null)} onDone={async (m) => { setDlg(null); setSel(new Set()); setOk(m); await load(); }} /> : null}
      {dlg?.k === 'profit' ? <ProfitDialog id={dlg.id} onClose={() => setDlg(null)} /> : null}
      {dlg?.k === 'pages' ? <PagesDialog onClose={() => setDlg(null)} /> : null}
      {dlg?.k === 'stats' ? <StatsDialog onClose={() => setDlg(null)} /> : null}
      {dlg?.k === 'work' ? <WorkDialog onClose={() => { setDlg(null); void load(); }} /> : null}
      {dlg?.k === 'my' ? <MyWorkDialog onClose={() => { setDlg(null); void load(); }} /> : null}
      {dlg?.k === 'eval' ? <EvalDialog onClose={() => setDlg(null)} /> : null}
      {dlg?.k === 'config' ? <ConfigDialog sa={!!d?.isSA} onClose={() => setDlg(null)} onDone={async () => { setDlg(null); setOk('Тохиргоо хадгалагдлаа'); await load(); }} /> : null}
    </div>
  );
}

interface VarData { days: string[]; variants: { id: number; code: string; label: string; daily: number[]; week: number; avg: number; phones: number[]; available: number }[] }
function useVariants(id: number) {
  const [v, setV] = useState<VarData | null>(null);
  useEffect(() => { let on = true; api<VarData>(`/api/goods-outflow?view=variants&id=${id}`).then((x) => { if (on) setV(x); }).catch(() => null); return () => { on = false; }; }, [id]);
  return v;
}
/** Өнгө / хэмжээ бүрийн догол мөр (хүснэгт) */
function VariantRows({ id, lead, sa, cover, onCover }: { id: number; lead: boolean; sa: boolean; cover?: Reorder['variants']; onCover?: () => void }) {
  const v = useVariants(id);
  if (!v) return <tr><td colSpan={30} className="px-8 py-1 text-[12px] text-muted">Ачаалж байна…</td></tr>;
  return (
    <>
      {v.variants.map((x) => (
        <tr key={x.id} data-variant-row className="border-t border-line/60 bg-surface2/50 text-[12px]">
          {lead ? <td /> : null}
          <td className="w-[160px] min-w-[160px] max-w-[160px] py-1 pl-7 pr-2"><div className="line-clamp-2 [overflow-wrap:anywhere] text-muted">↳ <b className="text-ink">{x.label}</b></div><div className="text-[10.5px] text-subtle">{x.code}</div></td>
          <td /><td /><td />
          {x.daily.map((n, i) => <td key={i} className="px-0.5 py-1 text-center"><div className={clsx('mx-auto w-9 rounded-md py-0.5', n ? 'font-semibold text-ink' : 'text-subtle')}>{n}</div>{x.phones[i] ? <div className="text-[10px] text-warn">☎{x.phones[i]}</div> : null}</td>)}
          <td className="px-1 py-1 text-center font-bold">{x.week}</td>
          <td className="hidden px-2 py-1 text-right min-[1360px]:table-cell">{x.avg}</td>
          <td className={clsx('px-2 py-1 text-right', x.available < x.avg && 'font-bold text-bad-ink')}>{x.available}</td>
          {sa ? <td /> : null}
          <td /><td />
          {sa ? <td className="px-1 py-1 text-center">{(() => { const c = cover?.find((y) => y.variantId === x.id); if (!c) return <span className="text-[11px] text-subtle">—</span>; return (
            <button type="button" data-variant-cover={c.level} onClick={onCover} className={clsx('inline-flex w-[76px] flex-col items-center rounded-lg px-1 py-0.5 leading-tight', RL[c.level].cls)}>
              <b className="text-[12px]">{c.days === null ? '—' : `${c.days} хоног`}</b><span className="text-[10px]">{c.order ? `🚚 ${md(c.order.expectedDay)}` : RL[c.level].label}</span>
            </button>); })()}</td> : null}
        </tr>
      ))}
    </>
  );
}
function VariantCards({ id, days }: { id: number; days: string[] }) {
  const v = useVariants(id);
  if (!v) return <p className="text-[12px] text-muted">Ачаалж байна…</p>;
  return (
    <div className="flex flex-col gap-1.5 border-l-2 border-line pl-2">
      {v.variants.map((x) => (
        <div key={x.id} className="flex min-w-0 flex-col gap-1">
          <div className="flex justify-between gap-2 text-[12.5px]"><b className="min-w-0 [overflow-wrap:anywhere]">↳ {x.label}</b><span className="shrink-0 text-muted">7 хоног <b className="text-ink">{x.week}</b> · боломжтой {x.available}</span></div>
          <div className="grid grid-cols-7 gap-1 text-center text-[11.5px]">{x.daily.map((n, i) => <div key={i} className="rounded bg-surface2 py-0.5"><div className="text-[9.5px] text-muted">{i === 0 ? 'Өнөө' : md(days[i]!)}</div>{n}</div>)}</div>
        </div>
      ))}
    </div>
  );
}

/** Мөрийн ард жижиг тэмдэг: 🔴 / 🟠 (ажиглаж буй бол 👁) — дарахад дэлгэрэнгүй */
const RL: Record<RLevel, { cls: string; label: string }> = {
  OK: { cls: 'text-muted hover:bg-surface2', label: 'хангалттай' },
  ORDER: { cls: 'bg-warn-soft text-warn', label: '🟠 татах' },
  URGENT: { cls: 'animate-pulse bg-bad text-white', label: '🔴 яаралтай' },
  ORDERED: { cls: 'bg-surface2 text-info-ink', label: '🚚 захиалсан' },
  LATE: { cls: 'bg-bad-soft text-bad-ink', label: '⏰ хоцорсон' },
};
/** Мөрийн хамгийн ард: нөөц хоног (зөвхөн Супер админ, #119) */
function ReorderChip({ r, onOpen }: { r: Row; onOpen: () => void }) {
  const x = r.reorder;
  if (!x) return <span className="text-[12px] text-subtle" title="Сүүлийн 7 хоногт зарагдаагүй">—</span>;
  const t = RL[x.level];
  return (
    <button type="button" data-reorder-chip={x.level} onClick={onOpen} title={`Боломжтой ${x.available} · өдөрт ~${x.pace}`}
      className={clsx('inline-flex w-[76px] flex-col items-center rounded-lg px-1 py-0.5 leading-tight', t.cls)}>
      <b className="text-[13px]">{x.days === null ? '—' : `${x.days} хоног`}</b>
      {x.worstLabel && (x.level === 'ORDER' || x.level === 'URGENT') ? <span className="line-clamp-1 max-w-full text-[10px] [overflow-wrap:anywhere]">{x.worstLabel}</span> : null}
      <span className="text-[10.5px]">{x.order ? (x.level === 'LATE' ? t.label : `🚚 ${md(x.order.expectedDay)}`) : t.label}</span>
    </button>
  );
}
interface ReorderD { info: Reorder | null; leadDays: number; urgentDays: number; defaultExpected: string; history: { id: number; qty: number; expectedDay: string; orderedAt: string; byName: string; note: string; receivedAt: string | null; cancelledAt: string | null; variantId: number | null }[] }
const coverCls = (l: RLevel) => (l === 'URGENT' || l === 'LATE' ? 'bg-bad-soft text-bad-ink' : l === 'ORDER' ? 'bg-warn-soft text-warn' : 'bg-surface2');
/** «Захиалсан» маягт — бараа бүхэлд нь эсвэл нэг өнгө / хэмжээнд (#128) */
function OrderForm({ defaultDay, onSave, onCancel }: { defaultDay: string; onSave: (qty: number, day: string, note: string) => Promise<void>; onCancel?: () => void }) {
  const [qty, setQty] = useState(''); const [day, setDay] = useState(defaultDay); const [note, setNote] = useState(''); const [e, setE] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
      {e ? <p className="text-[12.5px] text-bad-ink">{e}</p> : null}
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Ширхэг<input value={qty} inputMode="numeric" onChange={(ev) => setQty(digits(ev.target.value))} className={clsx(inputCls, 'text-right')} /></label>
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Ирэх өдөр<input type="date" value={day} onChange={(ev) => setDay(ev.target.value)} className={inputCls} /></label>
      </div>
      <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Тайлбар<input value={note} maxLength={300} onChange={(ev) => setNote(ev.target.value)} className={inputCls} /></label>
      <div className="flex justify-end gap-2">{onCancel ? <Button size="sm" onClick={onCancel}>Болих</Button> : null}<Button size="sm" variant="primary" onClick={() => { if (!Number(qty)) { setE('Захиалсан ширхэгээ бичнэ үү'); return; } void onSave(Number(qty), day, note); }}>Захиалсан</Button></div>
    </div>
  );
}
export function ReorderDialog({ row, onClose, post, detailUrl, sub = 'зөвхөн Супер админ' }: { row: { id: number; name: string; code: string }; onClose: () => void; post: (j: Record<string, unknown>, m?: string) => Promise<unknown>; detailUrl?: string; sub?: string }) {
  const [d, setD] = useState<ReorderD | null>(null); const [err, setErr] = useState<string | null>(null);
  const [formFor, setFormFor] = useState<number | 'all' | null>(null);
  const load = useCallback(() => api<ReorderD>(detailUrl ?? `/api/goods-outflow?view=reorder&id=${row.id}`).then((r) => { setD(r); }).catch((e) => setErr(msg(e))), [row.id, detailUrl]);
  useEffect(() => { void load(); }, [load]);
  const x = d?.info;
  const multi = !!x && x.variants.length > 1;
  const labelOf = (vid: number | null) => (vid === null ? null : x?.variants.find((v) => v.variantId === vid)?.label ?? `#${vid}`);
  const save = async (variantId: number | null, qty: number, day: string, note: string) => {
    const r = await post({ action: 'reorder', productId: row.id, ...(variantId ? { variantId } : {}), qty, expectedDay: day, note }, `«${row.name}${variantId ? ` · ${labelOf(variantId)}` : ''}» — захиалсан (${qty} ш, ${md(day)} ирнэ)`);
    if (r) { setFormFor(null); await load(); }
  };
  const cancel = async (id: number) => { if (confirm('«Захиалсан» тэмдгийг цуцлах уу? Сануулга дахин гарна.')) { const r = await post({ action: 'reorder-cancel', id }, 'Цуцаллаа'); if (r) await load(); } };
  const wholeOrder = x?.order && x.order.variantId === null ? x.order : null;
  return (
    <Modal open onClose={onClose} size={multi ? 'xl' : undefined} title={`🚚 Нөөц · ${row.name}`} subtitle={`${row.code} · ${sub}`} footer={<Button onClick={onClose}>Хаах</Button>}>
      {err ? <Notice>{err}</Notice> : null}
      {d ? (
        <div className="flex flex-col gap-3 text-[13.5px]">
          {x ? (<>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl bg-surface2 p-3"><div className="text-muted">Боломжтой (нийт)</div><b className="text-[17px]">{x.available}</b></div>
              <div className="rounded-xl bg-surface2 p-3"><div className="text-muted">Өдөрт гарц (нийт)</div><b className="text-[17px]">~{x.pace}</b></div>
              <div className={clsx('rounded-xl p-3', coverCls(x.level))}><div>Нөөц{x.worstLabel ? ` · ${x.worstLabel}` : ''}</div><b className="text-[17px]">{x.days === null ? '—' : `${x.days} хоног`}</b></div>
            </div>
            <p className="[overflow-wrap:anywhere]">
              {x.days === null ? 'Сүүлийн 7 хоногт зарагдаагүй — нөөц бодогдохгүй.' : <>{x.worstLabel ? <>Хамгийн түрүүнд <b>«{x.worstLabel}»</b> </> : 'Энэ хурдаар '}<b>{md(x.runOutDay!)}</b> орчим дуусна. Хятадаас захиалбал ~{d.leadDays} хоногт ирнэ
                {x.level === 'URGENT' ? <b className="text-bad-ink"> — яаралтай!</b> : x.level === 'ORDER' ? <b className="text-warn"> — бараагаа одоо татаарай.</b> : x.level === 'OK' ? ' — одоохондоо хангалттай.' : ''}</>}
            </p>
            {multi ? (
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full min-w-[560px] text-[13px]">
                  <thead><tr className="bg-surface2 text-[12px] text-muted"><th className="px-2 py-1.5 text-left">Өнгө / хэмжээ</th><th className="px-2 text-right">Боломжтой</th><th className="px-2 text-right">Өдөрт</th><th className="px-2 text-center">Нөөц</th><th className="px-2 text-right">Захиалга</th></tr></thead>
                  <tbody>{x.variants.map((v) => (
                    <Fragment key={v.variantId}>
                      <tr data-cover-variant={v.variantId} className="border-t border-line">
                        <td className="max-w-[200px] px-2 py-1.5 font-semibold [overflow-wrap:anywhere]">{v.label}</td>
                        <td className={clsx('px-2 text-right', v.available <= 0 && 'font-bold text-bad-ink')}>{v.available}</td>
                        <td className="px-2 text-right">{v.pace ? `~${v.pace}` : '—'}</td>
                        <td className="px-2 text-center"><span className={clsx('inline-block rounded-md px-1.5 py-0.5 text-[12px] font-bold', coverCls(v.level))}>{v.days === null ? '—' : `${v.days} хоног`} {RL[v.level].label.split(' ')[0]}</span></td>
                        <td className="px-2 py-1 text-right">{v.order ? (
                          <span className="inline-flex flex-wrap items-center justify-end gap-1 text-[12px]">🚚 {v.order.qty}ш · {md(v.order.expectedDay)}{v.order.variantId !== null ? <button type="button" onClick={() => void cancel(v.order!.id)} className="text-bad-ink underline">цуцлах</button> : <span className="text-subtle">(бүхэлд)</span>}</span>
                        ) : <Button size="sm" onClick={() => setFormFor(v.variantId)}>Захиалсан</Button>}</td>
                      </tr>
                      {formFor === v.variantId ? <tr><td colSpan={5} className="px-2 pb-2"><OrderForm defaultDay={d.defaultExpected} onSave={(q, dy, n) => save(v.variantId, q, dy, n)} onCancel={() => setFormFor(null)} /></td></tr> : null}
                    </Fragment>
                  ))}</tbody>
                </table>
              </div>
            ) : null}
            <p className="text-[12.5px] text-muted [overflow-wrap:anywhere]">Хурд = аль их нь: 7 хоногийн дундаж, сүүлийн 3 өдөр, өнөөдөр (өнгө тус бүрээр). Бөөний захиалга орохгүй.{multi ? ' Нэг өнгийг «Захиалсан» болгосон ч бусад өнгөний нөөц бодогдсоор байна; тэр өнгөний орлого ормогц дахин эхэлнэ.' : ''}</p>
          </>) : <p className="text-muted">Сүүлийн 7 хоногт зарагдаагүй.</p>}
          {!multi ? (wholeOrder || x?.order ? (() => { const o = (wholeOrder ?? x!.order)!; return (
            <div className={clsx('rounded-xl p-3', x?.level === 'LATE' ? 'bg-bad-soft text-bad-ink' : 'bg-surface2')}>
              <b>{x?.level === 'LATE' ? '⏰ Ирэх хугацаа хэтэрсэн' : '🚚 Захиалсан — ирэхийг хүлээж байна'}</b>
              <div className="[overflow-wrap:anywhere]">{o.qty} ширхэг · {md(o.expectedDay)} ирнэ · {o.byName}, {ubDateTime(o.orderedAt)}{o.note ? ` · ${o.note}` : ''}</div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-muted">Агуулахад орлого бүртгэгдэхэд автоматаар хаагдана.<Button size="sm" onClick={() => void cancel(o.id)}>«Захиалсан»-ыг цуцлах</Button></div>
            </div>); })() : (<><b>Захиалсан бол тэмдэглэ — сануулга зогсоно</b><OrderForm defaultDay={d.defaultExpected} onSave={(q, dy, n) => save(null, q, dy, n)} /></>)) : null}
          {d.history.length ? (
            <div className="text-[12.5px]"><b>Өмнөх захиалга</b>
              {d.history.map((h) => <div key={h.id} className="flex justify-between gap-2 border-t border-line py-1"><span className="min-w-0 [overflow-wrap:anywhere]">{ubDateTime(h.orderedAt)}{h.variantId ? ` · ${labelOf(h.variantId)}` : ''} · {h.qty} ш · {h.byName}</span><span className="shrink-0 text-muted">{h.receivedAt ? `✓ ирсэн ${ubDateTime(h.receivedAt)}` : h.cancelledAt ? 'цуцалсан' : `${md(h.expectedDay)} ирнэ`}</span></div>)}
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

interface PageShort { boostDays: number; rows: { productId: number; code: string; name: string; zones: number; dollar: number; adNumber: number | null; ownerName: string | null; boostDays: number; days: [string, string]; pages: { pageId: number; name: string; d2: number; d1: number; total: number; short: boolean }[] }[] }
/** Гаралтаа хангаагүй пэйж (#121): 5+ хоног бүүстэй бараа, пэйж бүрийн сүүлийн 2 өдрийн захиалга < $ */
function PageShortDialog({ onClose, post }: { onClose: () => void; post: (j: Record<string, unknown>, m?: string) => Promise<unknown> }) {
  const [d, setD] = useState<PageShort | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api<PageShort>('/api/goods-outflow?view=pageshort').then(setD).catch((e) => setErr(msg(e))), []);
  useEffect(() => { void load(); }, [load]);
  const off = async (r: PageShort['rows'][number]) => { if (confirm(`«${r.name}»-ийн бүүстийг унтраах уу? (Бүүст = 0)`)) { await post({ action: 'boost', productId: r.productId, zones: 0 }, `«${r.name}» бүүст унтарлаа`); await load(); } };
  return (
    <Modal open onClose={onClose} size="xl" title="⚠ Гаралтаа хангаагүй пэйж" subtitle={`Бүүст ${d?.boostDays ?? 5}+ хоног асаалттай бараа · пэйж бүрийн сүүлийн 2 өдрийн захиалга $-оос бага бол 🔴 · пэйжийг операторын сонголтоор`} footer={<Button onClick={onClose}>Хаах</Button>}>
      {err ? <Notice>{err}</Notice> : null}
      {d ? (d.rows.length ? (
        <div className="flex flex-col gap-3">
          {d.rows.map((r) => { const bad = r.pages.filter((x) => x.short); const good = r.pages.length - bad.length; return (
            <div key={r.productId} data-pageshort-row className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1"><b className="[overflow-wrap:anywhere]">{r.name}</b><div className="[overflow-wrap:anywhere] text-[12px] text-muted">{r.code} · {r.zones} бүүст × ${r.dollar}{r.adNumber !== null ? ` · AD${r.adNumber}` : ''} · {r.boostDays} хоног{r.ownerName ? ` · ${r.ownerName}` : ''}</div></div>
                <Button size="sm" variant="primary" onClick={() => void off(r)}>Бүүст унтраах</Button>
              </div>
              <p className="[overflow-wrap:anywhere] text-[13.5px] font-semibold text-bad-ink">{good ? `${good} пэйж хангасан, ` : ''}{bad.map((x) => `${x.name} (2 хоногт ${x.total})`).join(', ')} хангахгүй байна — шалгана уу</p>
              <div className="overflow-x-auto"><table className="w-full min-w-[360px] text-[13px]">
                <thead><tr className="text-[12px] text-muted"><th className="py-1 text-left">Пэйж</th><th className="px-2 text-right">{md(r.days[0])}</th><th className="px-2 text-right">{md(r.days[1])}</th><th className="px-2 text-right">2 хоног</th><th className="px-2 text-right">Босго</th></tr></thead>
                <tbody>{r.pages.map((x) => <tr key={x.pageId} className={clsx('border-t border-line', x.short && 'bg-bad-soft text-bad-ink')}><td className="max-w-[220px] py-1 [overflow-wrap:anywhere]">{x.short ? '🔴 ' : '✅ '}{x.name}</td><td className="px-2 text-right">{x.d2}</td><td className="px-2 text-right">{x.d1}</td><td className="px-2 text-right font-bold">{x.total}</td><td className="px-2 text-right text-muted">{r.dollar}</td></tr>)}</tbody>
              </table></div>
            </div>); })}
          <p className="text-[12px] text-muted">Оператор пэйжийг андуурч сонгох тохиолдол байдаг тул тоо бага зэрэг зөрж болно. Энэ нь зөвхөн анхааруулга — унтраах эсэхээ өөрөө шийднэ.</p>
        </div>
      ) : <p className="p-4 text-center text-muted">Гаралтаа хангаагүй пэйж алга 👍</p>) : <p className="text-muted">Ачаалж байна…</p>}
    </Modal>
  );
}

function AlertChip({ r, onOpen }: { r: Row; onOpen: () => void }) {
  const a = r.alertInfo;
  if (!a) return null;
  const watched = !!a.watchedUntil;
  return (
    <button type="button" data-alert-chip onClick={onOpen} title={a.reasons.join(' / ')}
      className={clsx('inline-flex h-8 w-8 items-center justify-center rounded-full text-[13px] font-bold', watched ? 'bg-surface2 text-muted' : a.level === 'RED' ? 'animate-pulse bg-bad text-white' : 'bg-warn-soft text-warn')}>
      {watched ? '👁' : a.level === 'RED' ? '🔴' : '🟠'}
    </button>
  );
}

function AlertDialog({ row, onClose, post }: { row: Row; onClose: () => void; post: (j: Record<string, unknown>, m?: string) => Promise<unknown> }) {
  const a = row.alertInfo!;
  const off = async () => { if (confirm(`«${row.name}»-ийн бүүстийг унтраах уу? (Бүүст = 0)`)) { await post({ action: 'boost', productId: row.id, zones: 0 }, `«${row.name}» бүүст унтарлаа`); onClose(); } };
  const watch = async () => { await post({ action: 'watch', productId: row.id }, `«${row.name}» 1 өдөр ажиглана`); onClose(); };
  return (
    <Modal open onClose={onClose} title={`${a.level === 'RED' ? '🔴 Алдагдалтай бүүст' : '🟠 Анхааруулга'} · ${row.name}`} subtitle={`${row.code} · ${row.zones} бүүст × $${row.dollar}${row.ownerName ? ` · ${row.ownerName}` : ''}`}
      footer={<><Button onClick={onClose}>Хаах</Button>{!a.watchedUntil ? <Button onClick={() => void watch()}>1 өдөр ажиглах</Button> : null}{row.zones > 0 ? <Button variant="primary" onClick={() => void off()}>Бүүст унтраах</Button> : null}</>}>
      <div className="flex flex-col gap-2">
        {a.reasons.map((x, i) => <p key={i} className={clsx('[overflow-wrap:anywhere] text-[14px] font-semibold', a.level === 'RED' ? 'text-bad-ink' : 'text-warn')}>{x}</p>)}
        <div className="rounded-xl bg-surface2 p-3 text-[13px]">
          <b>Пэйжээр</b>
          {a.pages.length ? a.pages.map((p) => <div key={p.name} className="flex justify-between gap-2"><span className="min-w-0 [overflow-wrap:anywhere]">{p.name}</span><b className="shrink-0">{p.n}</b></div>) : <div className="text-muted">Захиалга алга</div>}
        </div>
        <p className="text-[13px] text-muted">Сүүлийн 7 хоног: {row.daily.join(' · ')} (өнөөдрөөс)</p>
        {a.watchedUntil ? <p className="text-[13px] text-muted">👁 {a.watchedBy} ажиглаж байна — {ubDateTime(a.watchedUntil)} хүртэл</p> : null}
      </div>
    </Modal>
  );
}

function BoostCell({ row, field, post }: { row: Row; field: 'dollar' | 'zones' | 'adNumber'; post: (j: Record<string, unknown>, m?: string) => Promise<unknown> }) {
  const init = field === 'adNumber' ? (row.adNumber === null ? '' : String(row.adNumber)) : String(row[field]);
  const [v, setV] = useState(init);
  useEffect(() => setV(init), [init]);
  const label = field === 'dollar' ? '$' : field === 'zones' ? 'Бүүст' : 'AD';
  return (
    <td className="px-0.5 py-1 text-center">
      <input value={v} inputMode="numeric" aria-label={`${row.name} ${label}`} onChange={(e) => setV(digits(e.target.value))}
        onBlur={() => { if (v !== init && !(field !== 'adNumber' && v === '')) void post({ action: 'boost', productId: row.id, [field]: v === '' ? null : Number(v) }, field === 'zones' ? (Number(v) > 0 ? `«${row.name}» бүүст ${v} — ажиглалт эхэллээ` : `«${row.name}» бүүст унтарлаа`) : undefined); }}
        className={clsx('h-8 w-10 rounded-md border border-line bg-surface text-center text-[13px]', field === 'zones' && row.zones > 0 && 'border-accent font-bold text-accent')} />
    </td>
  );
}

function HoverCard({ id, x, y }: { id: number; x: number; y: number }) {
  const [d, setD] = useState<{ days: string[]; pages: { name: string; days: number[]; total: number }[]; stock: { total: number; available: number; driver: number } } | null>(null);
  useEffect(() => { let on = true; const t = setTimeout(() => { void api<NonNullable<typeof d>>(`/api/goods-outflow?view=pages&id=${id}`).then((r) => { if (on) setD(r); }).catch(() => null); }, 250); return () => { on = false; clearTimeout(t); }; }, [id]);
  if (!d) return null;
  return (
    <div className="pointer-events-none fixed z-50 w-[300px] max-w-[90vw] rounded-xl border border-line bg-surface p-3 text-[12.5px] shadow-lg" style={{ left: Math.min(x + 16, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 320), top: y + 12 }}>
      <b>Пэйжээр (3 хоног: {d.days.map(md).join(' · ')})</b>
      {d.pages.slice(0, 10).map((p) => <div key={p.name} className="flex justify-between gap-2"><span className="min-w-0 [overflow-wrap:anywhere]">{p.name}</span><span className="shrink-0 font-semibold">{p.days.join(' · ')}</span></div>)}
      {d.pages.length > 10 ? <div className="text-muted">+{d.pages.length - 10} илүү</div> : null}
      {d.pages.length === 0 ? <div className="text-muted">Захиалга алга</div> : null}
      <div className="mt-1 border-t border-line pt-1 text-muted">Агуулахад {d.stock.total} · захиалгад {d.stock.total - d.stock.available} · боломжтой <b className="text-ink">{d.stock.available}</b> · жолоочид {d.stock.driver}</div>
    </div>
  );
}

function EditDialog({ row, lead, owners, onClose, post }: { row: Row; lead: boolean; owners: { id: string; name: string }[]; onClose: () => void; post: (j: Record<string, unknown>, m?: string) => Promise<unknown> }) {
  const [note, setNote] = useState(row.note); const [own, setOwn] = useState(row.ownerId ?? '');
  const save = async () => {
    if (note !== row.note) await post({ action: 'note', productId: row.id, note });
    if (lead && own !== (row.ownerId ?? '')) await post({ action: 'owner', productIds: [row.id], userId: own || null });
    onClose();
  };
  return (
    <Modal open onClose={onClose} title={`Гарцын мэдээлэл · ${row.name}`} subtitle={row.doneAt ? `✓ Хийсэн · ${row.doneByName ?? ''} · ${ubDateTime(row.doneAt)}` : row.code}
      footer={<><Button onClick={onClose}>Болих</Button><Button variant="primary" onClick={() => void save()}>Хадгалах</Button></>}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-muted">Хариуцагч (маркетинг)
          <select value={own} disabled={!lead} onChange={(e) => setOwn(e.target.value)} className={inputCls}><option value="">— Хариуцагчгүй —</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          {!lead ? <span className="text-[12px] font-normal text-subtle">Хариуцагчийг ахлах маркетинг ононо</span> : null}
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-muted">Тэмдэглэл<textarea data-autofocus value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="rounded-[10px] border border-line bg-surface p-2.5 text-[13.5px]" /></label>
      </div>
    </Modal>
  );
}

function BulkDialog({ ids, owners, onClose, onDone }: { ids: number[]; owners: { id: string; name: string }[]; onClose: () => void; onDone: (m: string) => void }) {
  const [own, setOwn] = useState(''); const [err, setErr] = useState<string | null>(null);
  const save = async () => { try { const r = await api<{ updated: number }>('/api/goods-outflow', { method: 'POST', json: { action: 'owner', productIds: ids, userId: own || null } }); onDone(`${r.updated} барааны хариуцагч хадгалагдлаа`); } catch (e) { setErr(msg(e)); } };
  return (
    <Modal open onClose={onClose} title={`Бөөнөөр оноох · ${ids.length} бараа`} footer={<><Button onClick={onClose}>Болих</Button><Button variant="primary" disabled={!ids.length} onClick={() => void save()}>Оноох</Button></>}>
      <div className="flex flex-col gap-3">{err ? <Notice>{err}</Notice> : null}
        <select value={own} onChange={(e) => setOwn(e.target.value)} className={inputCls} aria-label="Маркетинг"><option value="">— Хариуцагчгүй болгох —</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
      </div>
    </Modal>
  );
}

interface Profit {
  product: { id: number; code: string; name: string; price: number; costPrice: number | null; unitCost: number; costEstimated: boolean };
  cfg: { oppCost: number; deliveryCost: number; rate: number; costPct: number };
  boost: { dollar: number; zones: number; target: number; dailySpend: number; boostOnAt: string | null }; marginBeforeBoost: number; perOrder: number;
  days: { day: string; qty: number; orders: number; revenue: number; cost: number; costEstimated: boolean; oppDelivery: number; boost: number; target: number; profit: number; perUnit: number | null; status: Status | null }[];
}
/** Эзний дүрэм (#153): бүүст = захиалга бүрт 1$ (ханш); асаалттай мөртлөө 0 захиалга бол зарцуулсан бүтэн дүн. Зорилт = бүүст × $ захиалга. */
function ProfitDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const [d, setD] = useState<Profit | null>(null); const [err, setErr] = useState<string | null>(null); const [price, setPrice] = useState('');
  useEffect(() => { api<Profit>(`/api/goods-outflow?view=profit&id=${id}`).then((r) => { setD(r); setPrice(String(r.product.price)); }).catch((e) => setErr(msg(e))); }, [id]);
  const trial = useMemo(() => {
    if (!d) return null; const pr = Number(price) || 0;
    const cost = d.product.costPrice ?? Math.round((pr * d.cfg.costPct) / 100);
    const m = pr - cost - d.cfg.oppCost - d.cfg.deliveryCost;
    const q = d.days[1]?.orders ?? 0;
    const boost = !d.boost.target ? 0 : q > 0 ? q * d.cfg.rate : d.boost.dailySpend;
    return { margin: m, perOrder: d.boost.target ? m - d.cfg.rate : m, day: q * m - boost, qty: q };
  }, [d, price]);
  const t = d?.boost.target ?? 0;
  return (
    <Modal open onClose={onClose} size="xl" title={d ? `Ашгийн задаргаа · ${d.product.name}` : 'Ашгийн задаргаа'} subtitle="Зөвхөн Супер админ · үнийг «Бараа» хуудаснаас засна" footer={<Button onClick={onClose}>Хаах</Button>}>
      {err ? <Notice>{err}</Notice> : null}
      {d ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 text-[13.5px] sm:grid-cols-4">
            <div className="rounded-xl bg-surface2 p-3"><div className="text-muted">Үнэ</div><b>{money(d.product.price)}</b></div>
            <div className="rounded-xl bg-surface2 p-3"><div className="text-muted">Өртөг{d.product.costEstimated ? ` (тааж ${d.cfg.costPct}%)` : ''}</div><b>{money(d.product.unitCost)}</b></div>
            <div className="rounded-xl bg-surface2 p-3"><div className="text-muted">Опп + хүргэлт</div><b>{money(d.cfg.oppCost + d.cfg.deliveryCost)}</b></div>
            <div className="rounded-xl bg-surface2 p-3"><div className="text-muted">Бүүст ({d.boost.zones} × ${d.boost.dollar})</div><b>{t ? `Зорилт ${t} захиалга/өдөр` : 'Унтраастай'}</b></div>
          </div>
          {t ? (
            <p className={clsx('rounded-xl p-3 text-[14px] font-semibold', d.perOrder < 0 ? 'bg-bad-soft text-bad-ink' : 'bg-ok-soft text-ok-ink')}>
              Бүүсттэй захиалгын ашиг: {money(d.product.price)} − {money(d.product.unitCost)} − {money(d.cfg.oppCost + d.cfg.deliveryCost)} − $1 ({money(d.cfg.rate)}) = <b>{money(d.perOrder)}</b>.
              {d.perOrder < 0 ? ' Энэ үнээр бүүст ашиггүй — үнэ/өртгөө шалгана уу.' : ` Өдөрт ${t}+ захиалга гарвал 🟢, ${Math.ceil(t * 1.5)}+ бол 💎, ${Math.ceil(t * 0.8)}–${t - 1} бол 🟠, түүнээс доош 🔴.`}
              {d.days[1] ? ` Өчигдөр ${d.days[1].orders}/${d.days[1].target || t} захиалга.` : ''}
            </p>) : <p className="text-[13.5px]">Бүүст унтраастай. Бүүстгүй захиалгын ашиг <b>{money(d.marginBeforeBoost)}</b>.</p>}
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead><tr className="bg-surface2 text-[12px] text-muted"><th className="px-2 py-1.5 text-left">Өдөр</th><th className="px-2 text-right">Ширхэг</th><th className="px-2 text-right">Захиалга</th><th className="px-2 text-right">Зорилт</th><th className="px-2 text-right">Орлого</th><th className="px-2 text-right">Өртөг</th><th className="px-2 text-right">Опп+хүргэлт</th><th className="px-2 text-right">Бүүст</th><th className="px-2 text-right">Ашиг</th><th className="px-2 text-right">Ашиг/захиалга</th></tr></thead>
              <tbody>{d.days.map((x, i) => (
                <tr key={x.day} className="border-t border-line"><td className="px-2 py-1.5">{i === 0 ? 'Өнөөдөр (одоог хүртэл)' : x.day}</td><td className="px-2 text-right">{x.qty}</td><td className="px-2 text-right">{x.orders}</td>
                  <td className={clsx('px-2 text-right font-bold', x.status && STATUS[x.status].cls)}>{x.target ? `${x.status ? `${STATUS[x.status].icon} ` : ''}${x.orders}/${x.target}` : '—'}</td>
                  <td className="px-2 text-right">{money(x.revenue)}</td><td className="px-2 text-right">{money(x.cost)}</td><td className="px-2 text-right">{money(x.oppDelivery)}</td>
                  <td className="px-2 text-right" title={x.target && !x.orders ? 'Захиалга гараагүй — өдөрт зарцуулсан бүтэн дүн' : x.target ? `${x.orders} захиалга × $1` : undefined}>{money(x.boost)}{x.target && !x.orders ? ' (зарцуулсан)' : ''}</td>
                  <td className={clsx('px-2 text-right font-bold', x.profit < 0 && 'text-bad-ink')}>{money(x.profit)}</td><td className={clsx('px-2 text-right font-bold', (x.perUnit ?? 0) < 0 && 'text-bad-ink')}>{money(x.perUnit)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
            <b className="text-[14px]">Үнэ туршиж үзэх (зөвхөн тооцоо)</b>
            <label className="flex items-center gap-2 text-[13px] text-muted">Шинэ үнэ<input value={price} inputMode="numeric" onChange={(e) => setPrice(digits(e.target.value))} className={clsx(inputCls, 'w-32 text-right')} aria-label="Шинэ үнэ" /></label>
            {trial ? <p className="text-[13.5px]">Бүүстгүй ашиг <b>{money(trial.margin)}</b>/захиалга{t ? <>, бүүсттэй (−$1) <b className={clsx(trial.perOrder < 0 && 'text-bad-ink')}>{money(trial.perOrder)}</b>/захиалга</> : null}. Өчигдрийн шиг {trial.qty} захиалга гарвал өдрийн <b className={clsx(trial.day < 0 && 'text-bad-ink')}>{money(trial.day)}</b>.</p> : null}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function PagesDialog({ onClose }: { onClose: () => void }) {
  const [d, setD] = useState<{ pages: { id: number; name: string; userId: string | null; userName: string | null }[]; users: { id: string; name: string }[]; canEdit: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { try { setD(await api('/api/goods-outflow?view=pageboard')); } catch (e) { setErr(msg(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  const set = async (pageId: number, userId: string) => { try { await api('/api/goods-outflow', { method: 'POST', json: { action: 'page-owner', pageId, userId: userId || null } }); await load(); } catch (e) { setErr(msg(e)); } };
  return (
    <Modal open onClose={onClose} title="Пэйж хувиарлах" subtitle="Нэг пэйж — нэг маркетинг (давхар тоологдохгүй)" footer={<Button onClick={onClose}>Хаах</Button>}>
      {err ? <Notice>{err}</Notice> : null}
      <div className="flex flex-col gap-2">
        {d?.pages.map((p) => (
          <div key={p.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-line pb-2">
            <b className="min-w-0 [overflow-wrap:anywhere]">{p.name}</b>
            <select value={p.userId ?? ''} disabled={!d.canEdit} onChange={(e) => void set(p.id, e.target.value)} className={inputCls} aria-label={`${p.name} маркетинг`}><option value="">— Оноогоогүй —</option>{d.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function StatsDialog({ onClose }: { onClose: () => void }) {
  const t = ubToday(); const [from, setFrom] = useState(t); const [to, setTo] = useState(t);
  const [d, setD] = useState<{ rows: { userId: string; userName: string; pages: number; orders: number; perPage: number; rank: number }[]; totals: { marketers: number; pages: number; orders: number } } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<NonNullable<typeof d>>(`/api/goods-outflow?view=stats&from=${from}&to=${to}`).then(setD).catch((e) => setErr(msg(e))); }, [from, to]);
  return (
    <Modal open onClose={onClose} title="Маркетингийн статистик" subtitle="Пэйжийн захиалга — гарцын дүрмээр" footer={<Button onClick={onClose}>Хаах</Button>}>
      {err ? <Notice>{err}</Notice> : null}
      <div className="mb-3 flex flex-wrap items-center gap-2"><input type="date" value={from} max={t} onChange={(e) => e.target.value && setFrom(e.target.value)} className={inputCls} aria-label="Эхлэх" /><span>—</span><input type="date" value={to} max={t} onChange={(e) => e.target.value && setTo(e.target.value)} className={inputCls} aria-label="Дуусах" /></div>
      {d ? (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-muted">{d.totals.marketers} маркетинг · {d.totals.pages} пэйж · {d.totals.orders} захиалга</p>
          {d.rows.map((r) => (
            <div key={r.userId} className="flex min-w-0 items-center justify-between gap-2 rounded-xl border border-line p-2.5">
              <div className="min-w-0"><b className="[overflow-wrap:anywhere]">#{r.rank} {r.userName}{r.rank === 1 ? ' 🏆' : ''}</b><div className="text-[12.5px] text-muted">{r.pages} пэйж · 1 пэйж ≈ {r.perPage}</div></div>
              <b className="shrink-0 text-[18px]">{r.orders}</b>
            </div>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}

interface Work {
  tab: string; total: number; page: number; pages: number; target: number; expireDays: number; canManageAll: boolean; me: string;
  rows: { id: number; code: string; name: string; price: number; available: number; note: string; doneAt: string | null; claim: { id: number; userId: string; userName: string; progress: number; mine: boolean } | null }[];
  mine: { id: number; productId: number; code: string; name: string; userName: string; claimedAt: string; progress: number; expiresAt: string }[];
  all: { id: number; productId: number; code: string; name: string; userName: string; claimedAt: string; progress: number; expiresAt: string }[];
}
function WorkDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState('idle'); const [q, setQ] = useState(''); const [page, setPage] = useState(1);
  const [d, setD] = useState<Work | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { try { setD(await api(`/api/goods-outflow?view=work&tab=${tab}&q=${encodeURIComponent(q)}&page=${page}`)); setErr(null); } catch (e) { setErr(msg(e)); } }, [tab, q, page]);
  useEffect(() => { const t = setTimeout(() => void load(), 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { const t = setInterval(() => void load(), 30_000); return () => clearInterval(t); }, [load]);
  const act = async (json: Record<string, unknown>) => { try { await api('/api/goods-outflow', { method: 'POST', json }); await load(); } catch (e) { setErr(msg(e)); } };
  const claimRow = (c: Work['mine'][number], cancel: boolean) => (
    <div key={c.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-2.5">
      <div className="min-w-0"><b className="[overflow-wrap:anywhere]">{c.name}</b><div className="text-[12px] text-muted">{c.code} · {c.userName} · {c.progress}/{d?.target} захиалга · {ubDateTime(c.expiresAt)} хүртэл</div></div>
      <Button size="sm" onClick={() => { if (!cancel || confirm(`${c.userName}-ийн сонголтыг цуцлах уу?`)) void act({ action: 'release', id: c.id }); }}>{cancel ? 'Цуцлах' : 'Буцаах'}</Button>
    </div>
  );
  return (
    <Modal open onClose={onClose} size="xl" title="Ажлын цонх" subtitle={d ? `Бараа сонгоод ${d.target} захиалгад хүргэвэл «Хийсэн ✓» · ${d.expireDays} хоногт хийгээгүй бол чөлөөлөгдөнө` : undefined} footer={<Button onClick={onClose}>Хаах</Button>}>
      {err ? <Notice>{err}</Notice> : null}
      {d?.mine.length ? <div className="mb-3 flex flex-col gap-2"><b className="text-[14px]">Миний сонгосон бараа</b>{d.mine.map((c) => claimRow(c, false))}</div> : null}
      {d?.canManageAll && d.all.filter((c) => !d.mine.some((m) => m.id === c.id)).length ? <div className="mb-3 flex flex-col gap-2"><b className="text-[14px]">Бусдын сонгосон бараа</b>{d.all.filter((c) => !d.mine.some((m) => m.id === c.id)).map((c) => claimRow(c, true))}</div> : null}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-xl bg-surface2 p-1">{([['idle', '3 өдөр захиалгагүй'], ['all', 'Бүх бараа']] as const).map(([k, l]) => <button key={k} type="button" onClick={() => { setTab(k); setPage(1); }} className={clsx('rounded-lg px-3 py-1.5 text-[13px] font-semibold', tab === k ? 'bg-surface shadow-sm' : 'text-muted')}>{l}</button>)}</div>
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Нэр, код" aria-label="Ажлын цонх хайх" className={clsx(inputCls, 'flex-1')} />
      </div>
      <div className="flex flex-col gap-1.5">
        {d?.rows.map((r) => (
          <div key={r.id} className="flex min-w-0 flex-wrap items-center gap-2 border-b border-line py-2">
            <div className="min-w-0 flex-1"><b className="[overflow-wrap:anywhere]">{r.name}</b>{r.doneAt ? ' ✓' : ''}<div className="[overflow-wrap:anywhere] text-[12px] text-muted">{r.code} · {money(r.price)} · боломжтой {r.available}{r.note ? ` · ${r.note}` : ''}</div></div>
            {r.claim ? <Badge tone={r.claim.mine ? 'accent' : 'neutral'}>{r.claim.userName} · {r.claim.progress}/{d.target}</Badge> : <Button size="sm" variant="primary" onClick={() => void act({ action: 'claim', productId: r.id })}>Сонгох</Button>}
          </div>
        ))}
        {d && d.rows.length === 0 ? <p className="p-4 text-center text-muted">Бараа алга</p> : null}
      </div>
      {d && d.pages > 1 ? <div className="mt-2 flex items-center justify-center gap-2 text-[13px]"><Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</Button>{page}/{d.pages}<Button size="sm" disabled={page >= d.pages} onClick={() => setPage(page + 1)}>›</Button></div> : null}
    </Modal>
  );
}

function MyWorkDialog({ onClose }: { onClose: () => void }) {
  const [d, setD] = useState<{ today: string; pages: string[]; products: { id: number; code: string; name: string; claimed: boolean; owned: boolean; dollar: number; zones: number; adNumber: number | null; boostOnAt: string | null }[] } | null>(null);
  const [vals, setVals] = useState<Record<number, { dollar: string; zones: string; ad: string }>>({});
  const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const r = await api<NonNullable<typeof d>>('/api/goods-outflow?view=my'); setD(r); setVals(Object.fromEntries(r.products.map((p) => [p.id, { dollar: String(p.dollar), zones: String(p.zones), ad: p.adNumber === null ? '' : String(p.adNumber) }]))); } catch (e) { setErr(msg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    try {
      for (const p of d?.products ?? []) {
        const v = vals[p.id]; if (!v) continue;
        if (v.dollar !== String(p.dollar) || v.zones !== String(p.zones) || v.ad !== (p.adNumber === null ? '' : String(p.adNumber)))
          await api('/api/goods-outflow', { method: 'POST', json: { action: 'boost', productId: p.id, dollar: Number(v.dollar) || 5, zones: Number(v.zones) || 0, adNumber: v.ad === '' ? null : Number(v.ad) } });
      }
      setOk('Өнөөдрийн бүүст хадгалагдлаа'); setErr(null); await load();
    } catch (e) { setErr(msg(e)); }
  };
  return (
    <Modal open onClose={onClose} size="xl" title="Өөрийн ажил" subtitle={d ? `${d.today} · бүүст бичсэн цагаас ажиглалт эхэлнэ, 0 болгоход унтарна` : undefined}
      footer={<><Button onClick={onClose}>Хаах</Button><Button variant="primary" onClick={() => void save()}>Хадгалах</Button></>}>
      {err ? <Notice>{err}</Notice> : null}{ok ? <Notice tone="ok">{ok}</Notice> : null}
      {d ? (
        <div className="flex flex-col gap-3">
          <p className="[overflow-wrap:anywhere] text-[13.5px]"><b>Миний пэйж:</b> {d.pages.length ? d.pages.join(', ') : 'оноогоогүй'}</p>
          {d.products.length === 0 ? <p className="text-muted">Сонгосон / хариуцсан бараа алга — «Ажлын цонх»-оос сонгоно уу.</p> : null}
          {d.products.map((p) => { const v = vals[p.id] ?? { dollar: '', zones: '', ad: '' }; const set = (k: 'dollar' | 'zones' | 'ad', x: string) => setVals({ ...vals, [p.id]: { ...v, [k]: digits(x) } });
            return (
              <div key={p.id} className="flex min-w-0 flex-wrap items-center gap-2 border-b border-line pb-2">
                <div className="min-w-0 flex-1"><b className="[overflow-wrap:anywhere]">{p.name}</b><div className="text-[12px] text-muted">{p.code} · {p.claimed ? 'сонгосон' : ''}{p.claimed && p.owned ? ' · ' : ''}{p.owned ? 'хариуцсан' : ''}{p.boostOnAt ? ` · бүүст ${ubDateTime(p.boostOnAt)}-аас` : ''}</div></div>
                <label className="flex items-center gap-1 text-[12.5px] text-muted">$<input value={v.dollar} inputMode="numeric" onChange={(e) => set('dollar', e.target.value)} className="h-9 w-14 rounded-md border border-line bg-surface text-center" aria-label={`${p.name} $`} /></label>
                <label className="flex items-center gap-1 text-[12.5px] text-muted">Бүүст<input value={v.zones} inputMode="numeric" onChange={(e) => set('zones', e.target.value)} className="h-9 w-14 rounded-md border border-line bg-surface text-center" aria-label={`${p.name} бүүст`} /></label>
                <label className="flex items-center gap-1 text-[12.5px] text-muted">AD<input value={v.ad} inputMode="numeric" onChange={(e) => set('ad', e.target.value)} className="h-9 w-14 rounded-md border border-line bg-surface text-center" aria-label={`${p.name} AD`} /></label>
              </div>
            ); })}
        </div>
      ) : null}
    </Modal>
  );
}

const CLS: Record<string, { l: string; tone: 'ok' | 'info' | 'warn' | 'bad' | 'neutral' }> = { EXCELLENT: { l: 'Маш сайн', tone: 'info' }, GOOD: { l: 'Сайн', tone: 'ok' }, AVERAGE: { l: 'Дунд', tone: 'warn' }, POOR: { l: 'Муу', tone: 'bad' }, NO_BOOST: { l: 'Бүүстгүй', tone: 'neutral' } };
function EvalDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'daily' | 'eval' | 'history'>('eval');
  const [date, setDate] = useState(shiftDay(ubToday(), -1));
  return (
    <Modal open onClose={onClose} size="xl" title="Маркетингийн үнэлгээ" footer={<Button onClick={onClose}>Хаах</Button>}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-xl bg-surface2 p-1">{([['eval', 'Нийт үнэлгээ'], ['daily', 'Өдрийн дэлгэрэнгүй'], ['history', 'Түүх']] as const).map(([k, l]) => <button key={k} type="button" onClick={() => setTab(k)} className={clsx('rounded-lg px-3 py-1.5 text-[13px] font-semibold', tab === k ? 'bg-surface shadow-sm' : 'text-muted')}>{l}</button>)}</div>
        {tab !== 'history' ? <input type="date" value={date} max={ubToday()} onChange={(e) => e.target.value && setDate(e.target.value)} className={inputCls} aria-label="Огноо" /> : null}
      </div>
      {tab === 'eval' ? <EvalTab date={date} /> : tab === 'daily' ? <DailyTab date={date} /> : <HistoryTab />}
    </Modal>
  );
}
interface EvalRow { userId: string; name: string; pages: number; boostCount: number; orderCount: number; excellent: number; good: number; poor: number; canScore: boolean;
  items: { productId: number; code: string; name: string; dollar: number | null; zones: number; expected: number; orders: number; cls: string }[];
  score: { score: number | null; salaryAmount: number; note: string; scoredByName: string; updatedAt: string } | null }
function EvalTab({ date }: { date: string }) {
  const [d, setD] = useState<{ rows: EvalRow[] } | null>(null); const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const load = useCallback(async () => { try { setD(await api(`/api/goods-outflow?view=eval&date=${date}`)); setErr(null); } catch (e) { setErr(msg(e)); } }, [date]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="flex flex-col gap-3">
      {err ? <Notice>{err}</Notice> : null}{ok ? <Notice tone="ok">{ok}</Notice> : null}
      <p className="text-[12.5px] text-muted">Хүлээгдэж буй = бүүст × $ · Маш сайн ≥ 2× · Сайн ≥ 1× · Дунд ≥ 0.5× · Муу. Оноо, цалинг ахлах маркетинг / админ бичнэ; цалин «Ажилтны цалин»-д автоматаар орно.</p>
      {d?.rows.map((r) => <EvalCard key={r.userId} r={r} date={date} onSaved={async (m) => { setOk(m); await load(); }} onErr={setErr} />)}
    </div>
  );
}
function EvalCard({ r, date, onSaved, onErr }: { r: EvalRow; date: string; onSaved: (m: string) => void; onErr: (e: string) => void }) {
  const [score, setScore] = useState(r.score?.score ? String(r.score.score) : ''); const [sal, setSal] = useState(r.score ? String(r.score.salaryAmount) : ''); const [note, setNote] = useState(r.score?.note ?? '');
  const save = async () => { try { const x = await api<{ warning: string | null }>('/api/goods-outflow', { method: 'POST', json: { action: 'score', userId: r.userId, date, score, salaryAmount: Number(sal) || 0, note } }); onSaved(x.warning ?? `${r.name}: үнэлгээ хадгалагдлаа`); } catch (e) { onErr(msg(e)); } };
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><b className="[overflow-wrap:anywhere] text-[15px]">{r.name}</b><span className="text-[12.5px] text-muted">{r.pages} пэйж · {r.boostCount} бүүст · {r.orderCount} захиалга · маш сайн {r.excellent} · сайн {r.good} · муу {r.poor}</span></div>
      {r.items.map((i) => (
        <div key={i.productId} className="flex min-w-0 items-center justify-between gap-2 text-[13px]">
          <span className="min-w-0 [overflow-wrap:anywhere]">{i.name} <span className="text-muted">({i.zones} × ${i.dollar ?? '—'} → {i.expected})</span></span>
          <span className="flex shrink-0 items-center gap-2"><b>{i.orders}</b><Badge tone={CLS[i.cls]?.tone}>{CLS[i.cls]?.l}</Badge></span>
        </div>
      ))}
      {r.canScore ? (
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-2">
          <label className="flex flex-col gap-1 text-[12px] text-muted">Оноо (1–10)<input value={score} inputMode="numeric" onChange={(e) => setScore(digits(e.target.value).slice(0, 2))} className={clsx(inputCls, 'w-20')} /></label>
          <label className="flex flex-col gap-1 text-[12px] text-muted">Цалин (₮)<input value={sal} inputMode="numeric" onChange={(e) => setSal(digits(e.target.value))} className={clsx(inputCls, 'w-32')} /></label>
          <label className="flex min-w-[160px] flex-1 flex-col gap-1 text-[12px] text-muted">Тэмдэглэл<input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} /></label>
          <Button size="sm" variant="primary" onClick={() => void save()}>Хадгалах</Button>
        </div>
      ) : r.score ? <p className="text-[12.5px] text-muted">Оноо {r.score.score ?? '—'} · цалин {money(r.score.salaryAmount)} · {r.score.scoredByName}</p> : null}
    </div>
  );
}
function DailyTab({ date }: { date: string }) {
  const [d, setD] = useState<{ days: string[]; rows: { userId: string; name: string; rank: number; dollars: number; zones: number; ads: number; week: number; items: { productId: number; code: string; name: string; dollar: number | null; zones: number; adNumber: number | null; available: number; daily: number[]; week: number }[] }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<NonNullable<typeof d>>(`/api/goods-outflow?view=daily&date=${date}`).then(setD).catch((e) => setErr(msg(e))); }, [date]);
  return (
    <div className="flex flex-col gap-3">
      {err ? <Notice>{err}</Notice> : null}
      {d?.rows.map((r) => (
        <div key={r.userId} className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><b className="[overflow-wrap:anywhere]">{r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `#${r.rank}`} {r.name}</b><span className="text-[12.5px] text-muted">${r.dollars} · {r.zones} бүүст · {r.ads} AD · 7 хоногт {r.week}</span></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-[12.5px]"><thead><tr className="text-muted"><th className="text-left">Бараа</th><th>$</th><th>Бүүст</th><th>AD</th><th>Боломжтой</th>{d.days.map((x) => <th key={x}>{md(x)}</th>)}</tr></thead>
            <tbody>{r.items.map((i) => <tr key={i.productId} className="border-t border-line text-center"><td className="w-[180px] min-w-[180px] max-w-[180px] [overflow-wrap:anywhere] py-1 text-left">{i.name}</td><td>{i.dollar ?? '—'}</td><td>{i.zones}</td><td>{i.adNumber ?? '—'}</td><td>{i.available}</td>{i.daily.map((n, k) => <td key={k}>{n}</td>)}</tr>)}</tbody></table></div>
        </div>
      ))}
    </div>
  );
}
function HistoryTab() {
  const t = ubToday(); const [from, setFrom] = useState(`${t.slice(0, 7)}-01`); const [to, setTo] = useState(t);
  const [d, setD] = useState<{ rows: { userId: string; name: string; days: number; salary: number; boostCount: number; orderCount: number; avgScore: number | null }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<NonNullable<typeof d>>(`/api/goods-outflow?view=history&from=${from}&to=${to}`).then(setD).catch((e) => setErr(msg(e))); }, [from, to]);
  return (
    <div className="flex flex-col gap-2">
      {err ? <Notice>{err}</Notice> : null}
      <div className="flex flex-wrap items-center gap-2"><input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className={inputCls} aria-label="Эхлэх" /><span>—</span><input type="date" value={to} max={t} onChange={(e) => e.target.value && setTo(e.target.value)} className={inputCls} aria-label="Дуусах" /></div>
      {d?.rows.map((r) => <div key={r.userId} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-2.5"><b className="min-w-0 [overflow-wrap:anywhere]">{r.name}</b><span className="text-[13px] text-muted">{r.days} өдөр · оноо ⌀{r.avgScore ?? '—'} · {r.boostCount} бүүст · {r.orderCount} захиалга · <b className="text-ink">{money(r.salary)}</b></span></div>)}
      {d && d.rows.length === 0 ? <p className="p-4 text-center text-muted">Үнэлгээ алга</p> : null}
    </div>
  );
}

function ConfigDialog({ sa, onClose, onDone }: { sa: boolean; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<Record<string, string> | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<Record<string, number>>('/api/goods-outflow?view=config').then((c) => setV(Object.fromEntries(Object.entries(c).map(([k, x]) => [k, String(x)])))).catch((e) => setErr(msg(e))); }, []);
  const f = (k: string, l: string) => <label key={k} className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">{l}<input value={v?.[k] ?? ''} inputMode="numeric" onChange={(e) => setV({ ...v!, [k]: digits(e.target.value) })} className={clsx(inputCls, 'text-right')} /></label>;
  const save = async () => {
    try {
      const keys = ['claimTarget', 'claimExpireDays', 'stockDays', ...(sa ? ['oppCost', 'deliveryCost', 'rate', 'costPct', 'watchHours', 'defaultDollar', 'bulkMin', 'leadDays', 'urgentDays'] : [])];
      await api('/api/goods-outflow', { method: 'POST', json: { action: 'config', ...Object.fromEntries(keys.map((k) => [k, Number(v?.[k])])), ...(sa ? { hideSupplierReorder: v?.hideSupplierReorder !== 'false' } : {}) } }); onDone();
    } catch (e) { setErr(msg(e)); }
  };
  return (
    <Modal open onClose={onClose} title="Барааны гарцын тохиргоо" footer={<><Button onClick={onClose}>Болих</Button><Button variant="primary" onClick={() => void save()}>Хадгалах</Button></>}>
      {err ? <Notice>{err}</Notice> : null}
      {v ? (
        <div className="flex flex-col gap-3">
          <b className="text-[14px]">Ажлын цонх</b>
          <div className="grid grid-cols-2 gap-3">{f('claimTarget', '«Хийсэн» болох захиалга')}{f('claimExpireDays', 'Чөлөөлөх хоног')}{f('stockDays', '🟠 Бараа дуусах анхааруулга (өдрийн гарц үлдэхэд)')}</div>
          {sa ? (<>
            <b className="text-[14px]">Бүүстийн ашиг (зөвхөн Супер админ)</b>
            <div className="grid grid-cols-2 gap-3">{f('oppCost', 'Опп цалин (₮/захиалга)')}{f('deliveryCost', 'Хүргэлтийн цалин (₮/захиалга)')}{f('rate', 'Долларын ханш (₮)')}{f('defaultDollar', 'Анхдагч $ (бүүст)')}{f('costPct', 'Өртөг оруулаагүй бол үнийн %')}{f('bulkMin', '📦 Бөөний захиалга (ширхэгээс)')}{f('watchHours', 'Ажиглах цаг (асаасан цагаас)')}</div>
            <b className="text-[14px]">🚚 Бараа татах (зөвхөн Супер админ)</b>
            <div className="grid grid-cols-2 gap-3">{f('leadDays', '🟠 Бараа ирэх хоног (нөөц үүнээс бага бол «татах»)')}{f('urgentDays', '🔴 Яаралтай (нөөц үүнээс бага)')}</div>
            <label className="flex items-start gap-2 text-[13px] font-semibold"><input type="checkbox" className="mt-0.5" checked={v.hideSupplierReorder !== 'false'} onChange={(e) => setV({ ...v, hideSupplierReorder: String(e.target.checked) })} /><span className="min-w-0 [overflow-wrap:anywhere]">Нийлүүлэгчийн дэлгүүрт оноосон барааг миний «Бараа татах»-д харуулахгүй (нийлүүлэгч өөрийн хуудаснаас харна)</span></label>
          </>) : null}
        </div>
      ) : null}
    </Modal>
  );
}
