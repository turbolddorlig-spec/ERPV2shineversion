'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Notice } from '@/components/ui/Notice';
import { Modal } from '@/components/ui/Modal';
import { OrderModal, type EditOrder, type FormLine, type OrderPrefill } from './OrderForm';
import { CallsModal } from './CallsClient';
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

/** Цагийн мэдээ (#52): бүх операторт — хуучин ERP шиг товч дарахад цонхоор нээгдэнэ */
function HourlyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [h, setH] = useState<Hourly | null>(null);
  useEffect(() => {
    if (!open) return;
    const load = () => api<Hourly>('/api/orders/hourly').then(setH).catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [open]);
  const medal = ['🥇', '🥈', '🥉'];
  return (
    <Modal open={open} onClose={onClose} size="xl" title={`⏱ Цагийн мэдээ${h ? ` · өнөөдөр ${h.total}` : ''}`} subtitle="Операторуудын өнөөдрийн баталгаажсан захиалга (цаг хүртэлх нийлбэр)">
      {!h ? <p className="py-6 text-center text-muted">Ачаалж байна…</p> : h.rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-[13px]">
            <thead><tr className="border-b border-line text-left text-[11.5px] uppercase text-muted"><th className="px-2 py-1.5">#</th><th className="px-2 py-1.5">Оператор</th>{h.cuts.map((c) => <th key={c} className="px-2 py-1.5 text-right">{c}:00 хүртэл</th>)}<th className="px-2 py-1.5 text-right">Нийт</th></tr></thead>
            <tbody>
              {h.rows.map((r) => (
                <tr key={r.name} className={clsx('border-b border-line/60', r.me && 'bg-accent-soft font-bold')}>
                  <td className="px-2 py-1.5">{medal[r.rank - 1] ?? r.rank}</td>
                  <td className="px-2 py-1.5">{r.name}{r.me ? ' (та)' : ''}</td>
                  {r.cum.map((n, i) => <td key={i} className="px-2 py-1.5 text-right text-muted">{n}</td>)}
                  <td className="px-2 py-1.5 text-right text-[14px] font-extrabold">{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="py-6 text-center text-muted">Өнөөдөр баталгаажсан захиалга алга</p>}
    </Modal>
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

const th = 'px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted';

/**
 * Захиалгын хуудас — хуучин ERP шиг: дэлгэц дүүрэн хүснэгт, жижиг үсэг;
 * «+ Захиалга», «Дуудлагын бүртгэл», «Цагийн мэдээ» нь цонхоор (ард тал бүдгэрнэ) нээгдэнэ.
 */
export function OrdersClient({ initialModal }: { initialModal?: { kind: 'new' } | { kind: 'edit'; id: number } | { kind: 'calls' } } = {}) {
  const router = useRouter();
  const [tab, setTab] = useState('today');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({ prepaid: false, noKhoroo: false, postponed: false, todayDelivery: false });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [orderModal, setOrderModal] = useState<{ edit?: EditOrder; addLines?: FormLine[]; prefill?: OrderPrefill; fromCalls?: boolean } | null>(null);
  // «Дуудлагын бүртгэл»-ийг дахин нээхэд шинэчлэгдэнэ
  const [callsOpen, setCallsOpen] = useState(initialModal?.kind === 'calls');
  const [callsKey, setCallsKey] = useState(0);
  const [hourlyOpen, setHourlyOpen] = useState(false);
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
    if (sp.get('tab')) setTab(sp.get('tab')!);
    if (initialModal?.kind === 'new') setOrderModal({ prefill: sp.get('phone') ? { phone: sp.get('phone')!, pageId: Number(sp.get('pageId')) || null, variantId: Number(sp.get('variantId')) || null, code: sp.get('code') } : undefined });
    if (initialModal?.kind === 'edit') openEdit(initialModal.id);
  }, [initialModal, openEdit]);
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

  // Цонх хаагдахад URL-ийг /orders болгоно (/orders/new, /orders/calls-оос орсон бол)
  const resetUrl = () => { if (window.location.pathname !== '/orders') window.history.replaceState(null, '', '/orders'); };

  const can = data?.can;
  const chip = (on: boolean) => clsx('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold', on ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-ink');
  return (
    <div className="full-bleed flex flex-col gap-3 text-[13px]">
      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] max-w-[420px] flex-1">
          <span className="sr-only">Хайх</span>
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle"><Icon name="search" size={15} /></span>
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Утас, дугаар, хаяг, бараа, тэмдэглэл…" className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-3 text-[13px] outline-none focus:border-accent" />
        </label>
        <div className="ml-auto flex items-center gap-2">
          <MoreMenu items={[
            { onClick: () => setHourlyOpen(true), label: 'Цагийн мэдээ', icon: 'history' },
            { href: '/loans?from=orders', label: 'Барааны хүсэлт', icon: 'hand' },
            { href: '/orders/blacklist', label: 'Хар жагсаалт', icon: 'alert' },
            ...(can?.supervise ? [{ href: '/orders/pages', label: 'Пэйж хуваарилах', icon: 'users' }] : []),
            ...(can?.review ? [{ href: '/orders/review', label: 'Хөнгөлөлт шалгах', icon: 'check' }] : []),
          ]} />
          <button type="button" onClick={() => setHourlyOpen(true)} className="hidden h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-3 text-[13px] font-semibold hover:bg-surface2 md:inline-flex">⏱ Цагийн мэдээ</button>
          <button type="button" onClick={() => setCallsOpen(true)} className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-warn/40 bg-warn-soft px-3 text-[13px] font-bold text-warn hover:brightness-95">📞 <span className="sm:hidden">Дуудлага</span><span className="hidden sm:inline">Дуудлагын бүртгэл</span></button>
          {can?.edit ? <button type="button" onClick={() => setOrderModal({})} className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3.5 text-[13px] font-bold text-on-accent"><Icon name="plus" size={15} strokeWidth={2.4} />Захиалга</button> : null}
        </div>
      </div>

      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <div className="flex w-max gap-1.5">
          {TABS.map((t) => (
            <button key={t.v} type="button" aria-pressed={tab === t.v} onClick={() => { setTab(t.v); setPage(1); }} className={chip(tab === t.v)}>
              {t.l}{data?.counts[t.v] !== undefined ? <span className={clsx('rounded-full px-1.5 text-[11px]', tab === t.v ? 'bg-on-ink/20' : 'bg-surface2')}>{data.counts[t.v]}</span> : null}
            </button>
          ))}
          <span className="mx-1 w-px self-stretch bg-line" />
          {([['todayDelivery', `🔴 Өнөөдөр хүргэх${data?.counts.todayDelivery ? ` ${data.counts.todayDelivery}` : ''}`], ['prepaid', 'Мөнгө орсон'], ['noKhoroo', 'Хороо тодорхойгүй'], ['postponed', 'Хойшилсон']] as const).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={filters[k]} onClick={() => { setFilters((f) => ({ ...f, [k]: !f[k] })); setPage(1); }} className={chip(filters[k])}>{l}</button>
          ))}
        </div>
      </div>
      {error ? <Notice>{error}</Notice> : null}

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[980px] text-[13px]">
          <thead className="border-b border-line bg-surface2/70">
            <tr><th className={clsx(th, 'w-[130px]')}>Захиалга</th><th className={clsx(th, 'w-[110px]')}>Утас</th><th className={th}>Бараа</th><th className={th}>Хаяг</th><th className={clsx(th, 'w-[150px]')}>Төлөв</th><th className={clsx(th, 'w-[95px] text-right')}>Дүн</th><th className={clsx(th, 'w-[130px]')}>Оператор</th><th className={clsx(th, 'w-[70px] text-center')}>Үйлдэл</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data?.items.map((o) => {
              const active = ['PENDING_PAYMENT', 'NEW', 'ASSIGNED'].includes(o.status);
              return (
                <tr key={o.id} onClick={() => router.push(`/orders/${o.id}`)} className={clsx('cursor-pointer align-top hover:bg-surface2/60', o.isToday && ['NEW', 'ASSIGNED'].includes(o.displayStatus) && 'bg-bad-soft/30')}>
                  <td className="px-2.5 py-2"><Link href={`/orders/${o.id}`} onClick={(e) => e.stopPropagation()} className="font-bold text-ink hover:underline">№{o.number}</Link><div className="text-[11.5px] text-subtle">{ubDateTime(o.createdAt)}</div></td>
                  <td className="select-text px-2.5 py-2" onClick={(e) => e.stopPropagation()}><div className="font-semibold">{formatPhone(o.phone)}</div>{o.extraPhone ? <div className="text-[11.5px] text-muted">{formatPhone(o.extraPhone)}</div> : null}</td>
                  <td className="px-2.5 py-2">
                    <div className="flex flex-col gap-1">
                      {o.lines.slice(0, 3).map((l) => <span key={l.id} className="flex items-center gap-1.5"><Thumb src={l.thumb} alt={`${l.name} ${l.label}`} size={26} /><span className="line-clamp-1">{l.name}{l.label ? ` · ${l.label}` : ''} <b>×{l.qty}</b></span></span>)}
                      {o.lines.length > 3 ? <span className="text-[11.5px] text-subtle">+{o.lines.length - 3} бараа</span> : null}
                    </div>
                  </td>
                  <td className="max-w-[280px] px-2.5 py-2"><div className="line-clamp-2 text-[12.5px]">{o.fullAddress}</div>{o.note ? <div className="line-clamp-1 text-[11.5px] text-muted">📝 {o.note}</div> : null}</td>
                  <td className="px-2.5 py-2"><StatusChip o={o} /></td>
                  <td className="px-2.5 py-2 text-right font-bold">{money(o.total)}</td>
                  <td className="px-2.5 py-2"><div className="line-clamp-1">{o.operatorName}</div>{o.pageName ? <div className="line-clamp-1 text-[11.5px] text-subtle">{o.pageName}</div> : null}</td>
                  <td className="px-2.5 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                    {can?.edit && active ? <button type="button" aria-label={`№${o.number} засах`} onClick={() => openEdit(o.id)} className="inline-grid h-8 w-8 place-items-center rounded-md hover:bg-surface2"><Icon name="edit" size={15} /></button>
                      : <Link href={`/orders/${o.id}`} aria-label={`№${o.number} харах`} className="inline-grid h-8 w-8 place-items-center rounded-md hover:bg-surface2"><Icon name="eye" size={15} /></Link>}
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
