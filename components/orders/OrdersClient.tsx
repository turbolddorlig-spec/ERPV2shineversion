'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Notice } from '@/components/ui/Notice';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';
import { money, ubDateTime } from '@/lib/format';
import { formatPhone } from '@/lib/phone';

export type DStatus = 'PENDING_PAYMENT' | 'SCHEDULED' | 'NEW' | 'ASSIGNED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED';
export const STATUS_TONE: Record<DStatus, 'warn' | 'info' | 'accent' | 'neutral' | 'ok' | 'bad'> = {
  PENDING_PAYMENT: 'warn', SCHEDULED: 'info', NEW: 'accent', ASSIGNED: 'neutral', OUT_FOR_DELIVERY: 'info', DELIVERED: 'ok', CANCELLED: 'bad',
};
export interface OLine { id: number; variantId: number; code: string; name: string; label: string; thumb: string | null; image: string | null; listPrice: number; unitPrice: number; qty: number; discountReason: string | null }
export interface OItem {
  id: number; number: string; status: string; displayStatus: DStatus; statusLabel: string; phone: string; extraPhone: string | null; fullAddress: string; noKhoroo: boolean;
  note: string | null; pageName: string | null; operatorName: string; deliveryDate: string; isToday: boolean; prepaid: boolean; createdAt: string;
  total: number; discount: number; deliveryFee: number; postponeCount: number; lines: OLine[]; cancelLabel: string | null;
}
interface ListResp { items: OItem[]; hasMore: boolean; counts: Record<string, number>; can: { edit: boolean; markPaid: boolean; supervise: boolean; review: boolean } }
interface Hourly { cuts: number[]; rows: { rank: number; name: string; cum: number[]; total: number; me: boolean }[]; total: number }

const TABS: { v: string; l: string }[] = [
  { v: 'today', l: 'Өнөөдөр үүссэн' }, { v: 'PENDING_PAYMENT', l: 'Төлбөр хүлээж буй' }, { v: 'NEW', l: 'Шинэ' }, { v: 'SCHEDULED', l: 'Он сар өдөртэй' },
  { v: 'ASSIGNED', l: 'Жолоочид оноосон' }, { v: 'OUT_FOR_DELIVERY', l: 'Хүргэлтэд гарсан' }, { v: 'DELIVERED', l: 'Хүргэсэн' }, { v: 'CANCELLED', l: 'Цуцлагдсан' }, { v: 'all', l: 'Бүгд' },
];

export function StatusChip({ o }: { o: Pick<OItem, 'displayStatus' | 'statusLabel' | 'deliveryDate' | 'isToday' | 'prepaid' | 'postponeCount' | 'noKhoroo'> }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge tone={STATUS_TONE[o.displayStatus]}>{o.statusLabel}{o.displayStatus === 'SCHEDULED' ? ` · ${o.deliveryDate.slice(5).replace('-', '/')}` : ''}</Badge>
      {o.isToday && ['NEW', 'ASSIGNED'].includes(o.displayStatus) ? <Badge tone="bad">🔴 Өнөөдөр</Badge> : null}
      {o.prepaid ? <Badge tone="ok">Мөнгө орсон</Badge> : null}
      {o.postponeCount ? <Badge tone="warn">Хойшилсон</Badge> : null}
      {o.noKhoroo ? <Badge tone="neutral">Хороо?</Badge> : null}
    </span>
  );
}

/** Цагийн мэдээ (#52): бүх операторт — хэн хэдэн захиалга үүсгэснийг харж уралдана */
function HourlyBoard() {
  const [h, setH] = useState<Hourly | null>(null);
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  useEffect(() => {
    const load = () => api<Hourly>('/api/orders/hourly').then(setH).catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (!h) return null;
  const medal = ['🥇', '🥈', '🥉'];
  return (
    <section className="rounded-[16px] border border-line bg-surface shadow-card">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center justify-between px-4 py-3">
        <span className="text-[15px] font-extrabold">⏱ Цагийн мэдээ · өнөөдөр {h.total}</span>
        <Icon name={open ? 'down' : 'right'} size={16} />
      </button>
      {open && h.rows.length ? (
        <div className="overflow-x-auto px-2 pb-3">
          <table className="w-full min-w-[480px] text-[13px]">
            <thead><tr className="text-left text-[11.5px] text-muted"><th className="px-2 py-1">#</th><th className="px-2 py-1">Оператор</th>{h.cuts.map((c) => <th key={c} className="px-2 py-1 text-right">–{c}</th>)}<th className="px-2 py-1 text-right">Нийт</th></tr></thead>
            <tbody>
              {(all ? h.rows : h.rows.filter((r) => r.rank <= 5 || r.me)).map((r) => (
                <tr key={r.name} className={clsx(r.me && 'bg-accent-soft font-bold')}>
                  <td className="px-2 py-1">{medal[r.rank - 1] ?? r.rank}</td>
                  <td className="px-2 py-1">{r.name}{r.me ? ' (та)' : ''}</td>
                  {r.cum.map((n, i) => <td key={i} className="px-2 py-1 text-right text-muted">{n}</td>)}
                  <td className="px-2 py-1 text-right text-[14px] font-extrabold">{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {h.rows.length > 6 ? <button type="button" onClick={() => setAll(!all)} className="mt-1 w-full rounded-lg py-2 text-[13px] font-semibold text-accent-ink hover:bg-surface2">{all ? 'Хураах' : `Бүх ${h.rows.length} операторыг харах`}</button> : null}
        </div>
      ) : open ? <p className="px-4 pb-3 text-[13px] text-muted">Өнөөдөр баталгаажсан захиалга алга</p> : null}
    </section>
  );
}

export function OrdersClient() {
  const [tab, setTab] = useState('today');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({ prepaid: false, noKhoroo: false, postponed: false, todayDelivery: false });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('done')) setFlash(sp.get('done'));
    if (sp.get('tab')) setTab(sp.get('tab')!);
  }, []);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    const sp = new URLSearchParams({ page: String(page) });
    if (q.trim()) sp.set('q', q.trim()); else sp.set('tab', tab);
    if (q.trim() && tab !== 'today') sp.set('tab', tab);
    for (const [k, v] of Object.entries(filters)) if (v) sp.set(k, '1');
    try {
      const r = await api<ListResp>(`/api/orders?${sp}`);
      if (id === reqId.current) { setData(r); setError(null); }
    } catch (e) { if (id === reqId.current) setError(e instanceof ApiError ? e.message : 'Ачаалж чадсангүй'); }
  }, [tab, q, filters, page]);
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);

  const can = data?.can;
  const chip = (on: boolean) => clsx('inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13.5px] font-semibold', on ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-ink');
  return (
    <div className="flex flex-col gap-4">
      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        {can?.edit ? <Link href="/orders/new" className="inline-flex h-11 items-center gap-2 rounded-[11px] bg-accent px-4 text-[14px] font-bold text-on-accent"><Icon name="plus" size={16} strokeWidth={2.4} />Захиалга</Link> : null}
        <Link href="/orders/calls" className="inline-flex h-11 items-center gap-2 rounded-[11px] border border-line bg-surface px-4 text-[14px] font-semibold">📞 Дуудлагын бүртгэл</Link>
        <Link href="/loans" className="inline-flex h-11 items-center gap-2 rounded-[11px] border border-line bg-surface px-4 text-[14px] font-semibold"><Icon name="hand" size={16} />Барааны хүсэлт</Link>
        <Link href="/orders/blacklist" className="inline-flex h-11 items-center gap-2 rounded-[11px] border border-line bg-surface px-4 text-[14px] font-semibold">⚠️ Хар жагсаалт</Link>
        {can?.supervise ? <Link href="/orders/pages" className="inline-flex h-11 items-center rounded-[11px] border border-line bg-surface px-4 text-[14px] font-semibold">Пэйж хуваарилах</Link> : null}
        {can?.review ? <Link href="/orders/review" className="inline-flex h-11 items-center rounded-[11px] border border-line bg-surface px-4 text-[14px] font-semibold">Хөнгөлөлт шалгах</Link> : null}
      </div>

      <HourlyBoard />

      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <div className="flex w-max gap-1.5">
          {TABS.map((t) => (
            <button key={t.v} type="button" aria-pressed={tab === t.v} onClick={() => { setTab(t.v); setPage(1); }} className={chip(tab === t.v)}>
              {t.l}{data?.counts[t.v] !== undefined ? <span className={clsx('rounded-full px-1.5 text-[12px]', tab === t.v ? 'bg-on-ink/20' : 'bg-surface2')}>{data.counts[t.v]}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <label className="relative min-w-[240px] flex-1">
          <span className="sr-only">Хайх</span>
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle"><Icon name="search" size={17} /></span>
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Утас, дугаар, хаяг, бараа, тэмдэглэл…" className="h-11 w-full rounded-xl border border-line bg-surface pl-10 pr-3 outline-none focus:border-accent" />
        </label>
        {([['todayDelivery', `🔴 Өнөөдөр хүргэх${data?.counts.todayDelivery ? ` ${data.counts.todayDelivery}` : ''}`], ['prepaid', 'Мөнгө орсон'], ['noKhoroo', 'Хороо тодорхойгүй'], ['postponed', 'Хойшилсон']] as const).map(([k, l]) => (
          <button key={k} type="button" aria-pressed={filters[k]} onClick={() => { setFilters((f) => ({ ...f, [k]: !f[k] })); setPage(1); }} className={chip(filters[k])}>{l}</button>
        ))}
      </div>
      {error ? <Notice>{error}</Notice> : null}

      <ul className="flex flex-col gap-2">
        {data?.items.map((o) => (
          <li key={o.id}>
            <Link href={`/orders/${o.id}`} className={clsx('flex flex-col gap-2 rounded-[16px] border bg-surface p-3.5 shadow-card hover:bg-surface2/50 md:flex-row md:items-center md:gap-4', o.isToday && ['NEW', 'ASSIGNED'].includes(o.displayStatus) ? 'border-bad/50' : 'border-line')}>
              <span className="flex min-w-[150px] flex-col gap-1">
                <span className="text-[15px] font-extrabold">№{o.number}</span>
                <span className="text-[12px] text-subtle">{ubDateTime(o.createdAt)}</span>
              </span>
              <span className="flex min-w-[130px] select-text flex-col text-[14px] font-semibold">
                <span>{formatPhone(o.phone)}</span>{o.extraPhone ? <span className="text-[12.5px] font-normal text-muted">{formatPhone(o.extraPhone)}</span> : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  {o.lines.slice(0, 3).map((l) => <span key={l.id} className="inline-flex items-center gap-1.5 text-[13px]"><Thumb src={l.thumb} alt={`${l.name} ${l.label}`} size={30} />{l.name}{l.label ? ` · ${l.label}` : ''} ×{l.qty}</span>)}
                  {o.lines.length > 3 ? <span className="text-[12px] text-subtle">+{o.lines.length - 3}</span> : null}
                </span>
                <span className="truncate text-[12.5px] text-muted">📍 {o.fullAddress}{o.note ? ` · ${o.note}` : ''}</span>
              </span>
              <span className="flex flex-col items-start gap-1 md:items-end">
                <span className="text-[16px] font-extrabold">{money(o.total)}</span>
                <StatusChip o={o} />
                <span className="text-[12px] text-subtle">{o.operatorName}{o.pageName ? ` · ${o.pageName}` : ''}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {data && !data.items.length ? <div className="rounded-[16px] border border-dashed border-line bg-surface p-8 text-center text-muted">Захиалга алга</div> : null}
      {!data && !error ? <p className="py-6 text-center text-muted">Ачаалж байна…</p> : null}
      {data && (page > 1 || data.hasMore) ? (
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-muted">{page}-р хуудас</span>
          <div className="flex gap-2">
            <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><Icon name="left" size={15} /> Өмнөх</Button>
            <Button size="sm" disabled={!data.hasMore} onClick={() => setPage((p) => p + 1)}>Дараах <Icon name="right" size={15} /></Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
