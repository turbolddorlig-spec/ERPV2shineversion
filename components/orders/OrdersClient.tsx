'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Notice } from '@/components/ui/Notice';
import { OrderModal, type EditOrder, type FormLine, type OrderPrefill } from './OrderForm';
import { CallsModal } from './CallsClient';
import { HourlyModal } from './HourlyModal';
import { CancelOrderModal, HistoryDrawer, PaidConfirmModal } from './OrderActions';
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
  total: number; discount: number; deliveryFee: number; postponeCount: number; lines: OLine[]; cancelLabel: string | null; inHandover: boolean; version: number; driverName?: string | null;
}
interface ListResp { items: OItem[]; hasMore: boolean; matched: number | null; matchedCapped: boolean; counts: Record<string, number>; can: { edit: boolean; markPaid: boolean; supervise: boolean; review: boolean } }


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

/** «⋯» товч: бага хэрэглэдэг хуудсууд */
function MoreMenu({ items }: { items: { href?: string; onClick?: () => void; label: string; icon: string }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  const cls = 'flex h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[13.5px] font-semibold hover:bg-surface2';
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label="Бусад" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-ink hover:bg-surface2"><Icon name="more" size={20} strokeWidth={2.6} /></button>
      {open ? (
        <div role="menu" className="absolute left-0 top-full z-40 mt-1.5 flex min-w-[210px] flex-col rounded-xl border border-line bg-surface p-1 shadow-pop md:left-auto md:right-0">
          {items.map((it) => it.href
            ? <Link key={it.label} role="menuitem" href={it.href} onClick={() => setOpen(false)} className={cls}><Icon name={it.icon} size={16} />{it.label}</Link>
            : <button key={it.label} type="button" role="menuitem" onClick={() => { setOpen(false); it.onClick?.(); }} className={cls}><Icon name={it.icon} size={16} />{it.label}</button>)}
        </div>
      ) : null}
    </div>
  );
}

interface Filters {
  statuses: string[]; operatorId: string; pageId: string; driverId: string; date: 'all' | 'today' | 'custom' | 'range'; day: string; from: string; to: string;
  prepaid: boolean; noKhoroo: boolean; postponed: boolean; todayDelivery: boolean;
}
const EMPTY_FILTERS: Filters = { statuses: [], operatorId: '', pageId: '', driverId: '', date: 'all', day: '', from: '', to: '', prepaid: false, noKhoroo: false, postponed: false, todayDelivery: false };
const activeCount = (f: Filters, advOnly = false) => [!advOnly && f.statuses.length > 0, !!f.operatorId, !!f.pageId, !!f.driverId, f.date !== 'all', f.prepaid, f.noKhoroo, f.postponed, f.todayDelivery].filter(Boolean).length;
const fsel = 'h-9 w-full rounded-lg border border-line bg-surface2/60 px-2.5 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-50';
/** Хуучин ERP-ийн «Төлөв» товч: олон төлөв чагтлан сонгоно */
const STATUS_OPTIONS: { v: string; l: string; dot: string }[] = [
  { v: 'NEW', l: 'Шинэ', dot: 'bg-accent' }, { v: 'PENDING_PAYMENT', l: 'Төлбөр хүлээж буй', dot: 'bg-warn' }, { v: 'SCHEDULED', l: 'Он сар өдөртэй', dot: 'bg-info' },
  { v: 'ASSIGNED', l: 'Жолоочид оноосон', dot: 'bg-subtle' }, { v: 'OUT_FOR_DELIVERY', l: 'Хүргэлтэд гарсан', dot: 'bg-info' }, { v: 'DELIVERED', l: 'Хүргэсэн', dot: 'bg-ok' }, { v: 'CANCELLED', l: 'Цуцлагдсан', dot: 'bg-bad' },
];
function StatusPicker({ value, onChange, counts }: { value: string[]; onChange: (v: string[]) => void; counts?: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} className="relative inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-semibold hover:bg-surface2">
        <Icon name="sliders" size={14} /><span className="hidden sm:inline">Төлөв</span>
        {value.length ? <span className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-accent text-[11px] text-on-accent">{value.length}</span> : null}
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-40 mt-1.5 w-60 rounded-xl border border-line bg-surface p-2 shadow-pop">
          <p className="mb-1 border-b border-line px-1.5 pb-1.5 text-[12.5px] font-semibold text-muted">Төлөв сонгох</p>
          {STATUS_OPTIONS.map((s) => (
            <label key={s.v} className="flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 text-[13px] hover:bg-surface2">
              <input type="checkbox" className="h-4 w-4" checked={value.includes(s.v)} onChange={(e) => onChange(e.target.checked ? [...value, s.v] : value.filter((x) => x !== s.v))} />
              <span className={clsx('h-2 w-2 rounded-full', s.dot)} />{s.l}
              {counts?.[s.v] !== undefined ? <span className="ml-auto text-[11.5px] text-subtle">{counts[s.v]}</span> : null}
            </label>
          ))}
          {value.length ? <button type="button" onClick={() => onChange([])} className="mt-1 w-full rounded-md py-1.5 text-[12px] font-semibold text-muted hover:bg-surface2">Бүгдийг арилгах</button> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Оператор санамж — хуучин ERP шиг хаягийн доор улаан шошго (бүх хуудсанд ялгарч харагдана) */
export function OperatorNote({ text, className }: { text: string; className?: string }) {
  return <div className={clsx('mt-1 inline-flex max-w-full items-start gap-1 rounded-md border border-bad/30 bg-bad-soft px-2 py-0.5 text-[11.5px] font-semibold text-bad-ink [overflow-wrap:anywhere]', className)}>{text}</div>;
}

/** Хуучин ERP шиг мөрийн төгсгөлийн жижиг icon товч (хулгана аваачихад нэр нь гарна) */
function IconBtn({ icon, label, onClick, tone, disabled }: { icon: string; label: string; onClick?: () => void; tone: 'ok' | 'info' | 'warn' | 'muted'; disabled?: boolean }) {
  const c = { ok: 'text-ok-ink hover:bg-ok-soft', info: 'text-info hover:bg-info-soft', warn: 'text-warn hover:bg-warn-soft', muted: 'text-subtle hover:bg-surface2 hover:text-ink' }[tone];
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick}
      className={clsx('grid h-7 w-7 place-items-center rounded-md', disabled ? 'cursor-not-allowed text-line' : c)}>
      <Icon name={icon} size={15} />
    </button>
  );
}

const th = 'px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted';

/**
 * Захиалгын хуудас — хуучин ERP шиг: дэлгэц дүүрэн хүснэгт, жижиг үсэг;
 * «+ Захиалга», «Дуудлагын бүртгэл», «Цагийн мэдээ» нь цонхоор (ард тал бүдгэрнэ) нээгдэнэ.
 */
export function OrdersClient({ initialModal }: { initialModal?: { kind: 'new' } | { kind: 'edit'; id: number } | { kind: 'calls' } } = {}) {
  // Хуучин ERP шиг: анхдагч — бүх төлөв, бүх огноо, шинэ нь эхэндээ
  const [q, setQ] = useState('');
  const [f, setF] = useState<Filters>(EMPTY_FILTERS);
  const [advOpen, setAdvOpen] = useState(false);
  const [ops, setOps] = useState<{ id: string; name: string }[]>([]);
  const [pages, setPages] = useState<{ id: number; name: string }[]>([]);
  const [drivers, setDrivers] = useState<{ id: string; name: string }[]>([]);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [orderModal, setOrderModal] = useState<{ edit?: EditOrder; addLines?: FormLine[]; prefill?: OrderPrefill; fromCalls?: boolean } | null>(null);
  // «Дуудлагын бүртгэл»-ийг дахин нээхэд шинэчлэгдэнэ
  const [callsOpen, setCallsOpen] = useState(initialModal?.kind === 'calls');
  const [callsKey, setCallsKey] = useState(0);
  const [hourlyOpen, setHourlyOpen] = useState(false);
  const [historyId, setHistoryId] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState<OItem | null>(null);
  const [paying, setPaying] = useState<OItem | null>(null);
  const reqId = useRef(0);

  const openEdit = useCallback(async (id: number, addLines?: FormLine[]) => {
    try {
      const r = await api<{ order: EditOrder }>(`/api/orders/${id}`);
      if (!['PENDING_PAYMENT', 'NEW', 'ASSIGNED'].includes(r.order.status)) { setError('Энэ захиалгыг засах боломжгүй (хаагдсан)'); return; }
      setOrderModal({ edit: r.order, addLines });
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Ачаалж чадсангүй'); }
  }, []);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('done')) setFlash(sp.get('done'));
    if (sp.get('tab')) setF((x) => ({ ...x, statuses: [sp.get('tab')!] }));
    api<{ items: { id: string; name: string }[] }>('/api/calls/operators').then((r) => setOps(r.items)).catch(() => undefined);
    api<{ pages: { id: number; name: string }[] }>('/api/orders/pages').then((r) => setPages(r.pages)).catch(() => undefined);
    api<{ items: { id: string; name: string }[] }>('/api/driver-lead/drivers').then((r) => setDrivers(r.items)).catch(() => undefined);
    if (initialModal?.kind === 'new') setOrderModal({ prefill: sp.get('phone') ? { phone: sp.get('phone')!, pageId: Number(sp.get('pageId')) || null, variantId: Number(sp.get('variantId')) || null, code: sp.get('code') } : undefined });
    if (initialModal?.kind === 'edit') openEdit(initialModal.id);
  }, [initialModal, openEdit]);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    const sp = new URLSearchParams({ page: String(page), statuses: f.statuses.join(',') });
    if (q.trim()) sp.set('q', q.trim());
    if (f.operatorId) sp.set('operatorId', f.operatorId);
    if (f.pageId) sp.set('pageId', f.pageId);
    if (f.driverId) sp.set('driverId', f.driverId);
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    if (f.date === 'today') { sp.set('from', today); sp.set('to', today); }
    if (f.date === 'custom' && f.day) { sp.set('from', f.day); sp.set('to', f.day); }
    if (f.date === 'range') { if (f.from) sp.set('from', f.from); if (f.to) sp.set('to', f.to); }
    for (const k of ['prepaid', 'noKhoroo', 'postponed', 'todayDelivery'] as const) if (f[k]) sp.set(k, '1');
    try {
      const r = await api<ListResp>(`/api/orders?${sp}`);
      if (id === reqId.current) { setData(r); setError(null); }
    } catch (e) { if (id === reqId.current) setError(e instanceof ApiError ? e.message : 'Ачаалж чадсангүй'); }
  }, [f, q, page]);
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);

  // Цонх хаагдахад URL-ийг /orders болгоно (/orders/new, /orders/calls-оос орсон бол)
  const resetUrl = () => { if (window.location.pathname !== '/orders') window.history.replaceState(null, '', '/orders'); };

  const can = data?.can;
  return (
    <div className="full-bleed flex flex-col gap-3 text-[13px]">
      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-[24px] font-extrabold tracking-tight">Захиалга</h1>
          <p className="text-[12.5px] text-muted">Захиалгууд удирдах, хянах</p>
        </div>
        <div className="flex items-center gap-2">
          <MoreMenu items={[
            { onClick: () => setHourlyOpen(true), label: 'Цагийн мэдээ', icon: 'history' },
            { href: '/loans?from=orders', label: 'Барааны хүсэлт', icon: 'hand' },
            { href: '/orders/blacklist', label: 'Хар жагсаалт', icon: 'alert' },
            ...(can?.supervise ? [{ href: '/orders/pages', label: 'Пэйж хуваарилах', icon: 'users' }] : []),
            ...(can?.review ? [{ href: '/orders/review', label: 'Хөнгөлөлт шалгах', icon: 'check' }] : []),
          ]} />
          <button type="button" onClick={() => setHourlyOpen(true)} className="hidden h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-3 text-[13px] font-semibold hover:bg-surface2 md:inline-flex">⏱ Цагийн мэдээ</button>
          <button type="button" onClick={() => setCallsOpen(true)} className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-warn/40 bg-warn-soft px-3 text-[13px] font-bold text-warn hover:brightness-95">📞 <span className="sm:hidden">Дуудлага</span><span className="hidden sm:inline">Дуудлагын бүртгэл</span></button>
          {can?.edit ? <button type="button" onClick={() => setOrderModal({})} className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3.5 text-[13px] font-bold text-on-accent"><Icon name="plus" size={15} strokeWidth={2.4} />Шинэ захиалга</button> : null}
        </div>
      </div>

      {/* Хуучин шиг жижиг статистик */}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {data?.matched !== null && data?.matched !== undefined ? <span className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1"><Icon name="search" size={13} /><span className="text-muted">Үр дүн:</span><b>{data.matchedCapped ? '10,000+' : data.matched.toLocaleString('en-US')}</b></span> : null}
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-info/20 bg-info-soft px-2.5 py-1"><span className="text-muted">🛒 Өнөөдөр:</span><b className="text-info">{data?.counts.today ?? '…'}</b></span>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-warn/20 bg-warn-soft px-2.5 py-1"><span className="text-muted">📅 Маргааш:</span><b className="text-warn">{data?.counts.postponed ?? 0}</b></span>
      </div>

      {/* Шүүлтүүр — хуучин ERP-ийн бүтэц */}
      <div className="rounded-xl border border-line bg-surface">
        <div className="flex flex-wrap gap-2 p-3">
          <label className="relative min-w-[200px] flex-1">
            <span className="sr-only">Хайх</span>
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle"><Icon name="search" size={15} /></span>
            <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
              placeholder="Утас, хаяг, барааны нэр/код хайх..." className="h-9 w-full rounded-lg border border-line bg-surface2/60 pl-9 pr-3 text-[13px] outline-none focus:border-accent focus:bg-surface" />
          </label>
          <StatusPicker value={f.statuses} counts={data?.counts} onChange={(statuses) => { setF((x) => ({ ...x, statuses })); setPage(1); }} />
          <button type="button" onClick={() => load()} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-[13px] font-semibold text-on-ink"><Icon name="search" size={14} /><span className="hidden sm:inline">Хайх</span></button>
          {activeCount(f) || q ? <button type="button" onClick={() => { setF(EMPTY_FILTERS); setQ(''); setPage(1); }} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold text-muted hover:text-ink"><Icon name="close" size={14} /><span className="hidden sm:inline">Цэвэрлэх</span></button> : null}
        </div>
        <button type="button" aria-expanded={advOpen} onClick={() => setAdvOpen(!advOpen)} className="flex w-full items-center gap-1.5 border-t border-line px-3 py-2 text-[12.5px] font-semibold text-muted hover:bg-surface2/50">
          <Icon name={advOpen ? 'up' : 'down'} size={13} />Нэмэлт шүүлтүүр{activeCount(f, true) ? <span className="rounded-full bg-accent px-1.5 text-[11px] text-on-accent">{activeCount(f, true)}</span> : null}
        </button>
        {advOpen ? (
          <div className="border-t border-line p-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
              <select aria-label="Оператор" value={f.operatorId} onChange={(e) => { setF((x) => ({ ...x, operatorId: e.target.value })); setPage(1); }} className={fsel}>
                <option value="">Бүх оператор</option>
                {ops.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <select aria-label="Хуудас" value={f.pageId} onChange={(e) => { setF((x) => ({ ...x, pageId: e.target.value })); setPage(1); }} className={fsel}>
                <option value="">Бүх хуудас</option>
                {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select aria-label="Жолооч" value={f.driverId} onChange={(e) => { setF((x) => ({ ...x, driverId: e.target.value })); setPage(1); }} className={fsel}>
                <option value="">Бүх жолооч</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <select aria-label="Огноо" value={f.date} onChange={(e) => { setF((x) => ({ ...x, date: e.target.value as Filters['date'] })); setPage(1); }} className={fsel}>
                <option value="all">Бүх огноо</option>
                <option value="today">Өнөөдөр</option>
                <option value="custom">Огноо сонгох</option>
                <option value="range">Хугацаа сонгох</option>
              </select>
              {f.date === 'custom' ? <input type="date" aria-label="Огноо" value={f.day} onChange={(e) => { setF((x) => ({ ...x, day: e.target.value })); setPage(1); }} className={fsel} /> : null}
              {f.date === 'range' ? <>
                <input type="date" aria-label="Эхлэх" value={f.from} onChange={(e) => { setF((x) => ({ ...x, from: e.target.value })); setPage(1); }} className={fsel} />
                <input type="date" aria-label="Дуусах" value={f.to} onChange={(e) => { setF((x) => ({ ...x, to: e.target.value })); setPage(1); }} className={fsel} />
              </> : null}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3 text-[13px]">
              {([['postponed', 'Маргааш товчоор үүссэн', 'text-warn'], ['prepaid', 'Мөнгө орсон', 'text-ok-ink'], ['noKhoroo', 'Хороо тодорхойгүй', 'text-muted'], ['todayDelivery', `🔴 Өнөөдөр хүргэх${data?.counts.todayDelivery ? ` (${data.counts.todayDelivery})` : ''}`, 'text-bad-ink']] as const).map(([k, l, c]) => (
                <label key={k} className={clsx('flex cursor-pointer items-center gap-2', c)}>
                  <input type="checkbox" className="h-4 w-4" checked={f[k]} onChange={(e) => { setF((x) => ({ ...x, [k]: e.target.checked })); setPage(1); }} />{l}
                </label>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {error ? <Notice>{error}</Notice> : null}

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[1080px] text-[13px]">
          <thead className="border-b border-line bg-surface2/70">
            <tr><th className={clsx(th, 'w-[130px]')}>Захиалга</th><th className={clsx(th, 'w-[110px]')}>Утас</th><th className={th}>Бараа</th><th className={th}>Хаяг</th><th className={clsx(th, 'w-[150px]')}>Төлөв</th><th className={clsx(th, 'w-[95px] text-right')}>Дүн</th><th className={clsx(th, 'w-[130px]')}>Оператор</th><th className={clsx(th, 'w-[110px]')}>Жолооч</th><th className={clsx(th, 'w-[124px] text-center')}>Үйлдэл</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data?.items.map((o) => {
              const active = ['PENDING_PAYMENT', 'NEW', 'ASSIGNED'].includes(o.status);
              return (
                <tr key={o.id} className={clsx('align-top hover:bg-surface2/50', o.isToday && ['NEW', 'ASSIGNED'].includes(o.displayStatus) && 'bg-bad-soft/30')}>
                  <td className="select-text px-2.5 py-2"><div className="font-bold">№{o.number}</div><div className="text-[11.5px] text-subtle">{ubDateTime(o.createdAt)}</div></td>
                  <td className="select-text px-2.5 py-2"><div className="font-semibold">{formatPhone(o.phone)}</div>{o.extraPhone ? <div className="text-[11.5px] text-muted">{formatPhone(o.extraPhone)}</div> : null}</td>
                  <td className="px-2.5 py-2">
                    <div className="flex flex-col gap-1">
                      {o.lines.slice(0, 3).map((l) => <span key={l.id} className="flex items-center gap-1.5"><Thumb src={l.thumb} alt={`${l.name} ${l.label}`} size={26} zoom={l.code} /><span className="line-clamp-1">{l.name}{l.label ? ` · ${l.label}` : ''} <b className="whitespace-nowrap">{l.qty}ш</b></span></span>)}
                      {o.lines.length > 3 ? <span className="text-[11.5px] text-subtle">+{o.lines.length - 3} бараа</span> : null}
                    </div>
                  </td>
                  <td className="max-w-[280px] select-text px-2.5 py-2"><div className="line-clamp-2 text-[12.5px]">{o.fullAddress}</div>{o.note ? <OperatorNote text={o.note} /> : null}</td>
                  <td className="px-2.5 py-2"><StatusChip o={o} /></td>
                  <td className="px-2.5 py-2 text-right font-bold">{money(o.total)}</td>
                  <td className="px-2.5 py-2"><div className="line-clamp-1">{o.operatorName}</div>{o.pageName ? <div className="line-clamp-1 text-[11.5px] text-subtle">{o.pageName}</div> : null}</td>
                  <td className="px-2.5 py-2">{o.driverName ? <div className="line-clamp-1">{o.driverName}</div> : <span className="text-subtle">—</span>}</td>
                  <td className="px-1.5 py-1.5">
                    <div className="flex items-center justify-center gap-0.5">
                      {o.status === 'PENDING_PAYMENT' && can?.markPaid ? <IconBtn tone="ok" icon="cash" label="Мөнгө орсон" onClick={() => setPaying(o)} /> : null}
                      {active && can?.edit ? (o.inHandover
                        ? <IconBtn tone="muted" icon="edit" label="Падаан үүссэн — засах боломжгүй" disabled />
                        : <IconBtn tone="info" icon="edit" label="Засах" onClick={() => openEdit(o.id)} />) : null}
                      <IconBtn tone="muted" icon="history" label="Түүх" onClick={() => setHistoryId(o.id)} />
                      {active && can?.edit ? <IconBtn tone="warn" icon="xcircle" label="Цуцлах" onClick={() => setCancelling(o)} /> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data && !data.items.length ? <div className="p-8 text-center text-muted">Захиалга алга</div> : null}
        {!data && !error ? <p className="py-6 text-center text-muted">Ачаалж байна…</p> : null}
      </div>
      {data && (page > 1 || data.hasMore) ? (
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] text-muted">{page}-р хуудас</span>
          <div className="flex gap-2">
            <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><Icon name="left" size={15} /> Өмнөх</Button>
            <Button size="sm" disabled={!data.hasMore} onClick={() => setPage((p) => p + 1)}>Дараах <Icon name="right" size={15} /></Button>
          </div>
        </div>
      ) : null}

      <HistoryDrawer orderId={historyId} onClose={() => setHistoryId(null)} />
      <CancelOrderModal order={cancelling} onClose={() => setCancelling(null)} onDone={(m) => { setCancelling(null); setFlash(m); load(); }} />
      <PaidConfirmModal order={paying} onClose={() => setPaying(null)} onDone={(m) => { setPaying(null); setFlash(m); load(); }} />
      <HourlyModal open={hourlyOpen} onClose={() => setHourlyOpen(false)} />
      <CallsModal key={callsKey} open={callsOpen} onClose={() => { setCallsOpen(false); resetUrl(); }}
        onCreateOrder={(prefill) => { setCallsOpen(false); setOrderModal({ prefill, fromCalls: true }); }} />
      <OrderModal open={!!orderModal} edit={orderModal?.edit} addLines={orderModal?.addLines} prefill={orderModal?.prefill}
        onClose={() => { setOrderModal(null); resetUrl(); }}
        onDone={(msg) => { setOrderModal(null); setFlash(msg); resetUrl(); load(); setCallsKey((k) => k + 1); }}
        onAddToExisting={(id, lines) => { setOrderModal(null); openEdit(id, lines); }} />
    </div>
  );
}
