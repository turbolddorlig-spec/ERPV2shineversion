'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';
import { ZoomButton } from '@/components/ui/Lightbox';
import { OperatorNote } from '@/components/orders/OrdersClient';
import { money, ubDateTime } from '@/lib/format';

interface BDriver { id: string; name: string; phone: string; orders: number; trusted: boolean; approved: boolean; approvalNote: string | null; approvalBy: string | null; handover: { id: number; number: string; status: string } | null; stateLabel: string }
interface Board { date: string; canOperate: boolean; canApprove: boolean; drivers: BDriver[] }
interface Item { variantId: number; code: string; name: string; label: string; qty: number; amount: number; thumb: string | null; image: string | null; shelfCode: string | null; checked: boolean; checkedBy: string | null }
interface HOrder { orderId: number; position: number; number: string; phone: string; total: number; createdAt: string | null; status: string | null; note: string | null; isNew: boolean; removedAt: string | null; removeReason: string | null; lines: { name: string; label: string; code: string; qty: number; unitPrice: number }[] }
interface Detail {
  id: number; number: string; date: string; driverId: string; driverName: string; status: 'DRAFT' | 'PREPARED' | 'HANDED_OVER'; statusLabel: string; version: number;
  createdByName: string; createdAt: string; preparedBy: string | null; preparedAt: string | null; handedOverBy: string | null; handedOverAt: string | null; canOperate: boolean;
  totals: { orders: number; pieces: number; amount: number; checked: number; kinds: number }; items: Item[]; orders: HOrder[];
}
interface Eligible { id: number; number: string; phone: string; items: number; total: number; note: string | null }
interface Day { handover: Detail | null; eligible: Eligible[]; approval: { approved: boolean; source: string; note: string | null; byName: string | null } }

const ubToday = (add = 0) => new Date(Date.now() + 8 * 3600_000 + add * 86_400_000).toISOString().slice(0, 10);
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const ST_TONE: Record<string, string> = { DRAFT: 'bg-surface2 text-muted', PREPARED: 'bg-info-soft text-info', HANDED_OVER: 'bg-warn-soft text-warn' };
const STATE_TONE: Record<string, string> = { 'Бэлдээгүй': 'text-bad-ink', 'Бэлдэж байна': 'text-warn', 'Бэлдсэн': 'text-info', 'Өгсөн': 'text-ok-ink', '—': 'text-subtle' };

/**
 * «Жолоочид бараа өгөх (iPad)» — хуучин ERP-ийн урсгал: жолооч + огноо → захиалгуудаа (бүгдийг) сонгож «Падаан үүсгэх» →
 * бараа бүрийг Check (заавал) → «Бэлтгэсэн» → «Барааг бүрэн өгсөн» (бараа агуулахаас жолоочид шилжинэ).
 */
export function HandoverClient() {
  const [date, setDate] = useState(ubToday());
  const [board, setBoard] = useState<Board | null>(null);
  const [driverId, setDriverId] = useState('');
  const [day, setDay] = useState<Day | null>(null);
  const [short, setShort] = useState<{ code: string; name: string; need: number; have: number }[]>([]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);

  const loadBoard = useCallback(() => api<Board>(`/api/handover?date=${date}`).then(setBoard).catch((e) => setError(msg(e))), [date]);
  const loadDay = useCallback(async () => {
    if (!driverId) { setDay(null); return; }
    try {
      const d = await api<Day>(`/api/handover?driverId=${driverId}&date=${date}`);
      setDay(d); setSel(new Set(d.eligible.map((o) => o.id)));
      if (d.handover) setShort((await api<{ shortages: typeof short }>(`/api/handover/${d.handover.id}`)).shortages); else setShort([]);
    } catch (e) { setError(msg(e)); }
  }, [driverId, date]);
  useEffect(() => { loadBoard(); }, [loadBoard]);
  useEffect(() => { loadDay(); }, [loadDay]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setError(null); setFlash(null);
    try { await fn(); setFlash(ok); await Promise.all([loadDay(), loadBoard()]); } catch (e) { setError(msg(e)); await loadDay(); } finally { setBusy(false); }
  }
  const h = day?.handover ?? null;
  const drv = board?.drivers.find((d) => d.id === driverId);
  const canOperate = !!board?.canOperate;

  return (
    <div className="full-bleed flex flex-col gap-3 text-[13px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-[24px] font-extrabold tracking-tight">Жолоочид бараа өгөх {h ? <span className={clsx('rounded-md px-2 py-0.5 text-[12px] font-bold', ST_TONE[h.status])}>{h.statusLabel}</span> : null}</h1>
          <p className="text-[12.5px] text-muted">Падаан үүсгэх, бэлтгэх, жолоочид бараа хүлээлгэн өгөх (iPad)</p>
        </div>
        <div className="flex gap-2">
          {board?.canApprove ? <button type="button" onClick={() => setApprovalsOpen(true)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-semibold hover:bg-surface2"><Icon name="calc" size={15} />Нягтлан OKEY</button> : null}
          <Link href="/handover/returns" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-semibold hover:bg-surface2"><Icon name="refresh" size={15} />Буцаалт хүлээн авах</Link>
          <Link href="/handover/history" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-semibold hover:bg-surface2"><Icon name="history" size={15} />Падааны түүх</Link>
        </div>
      </div>

      <div className="grid gap-3 rounded-xl border border-line bg-surface p-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,0.6fr)_minmax(0,1.4fr)]">
        <DriverPicker drivers={board?.drivers ?? []} value={driverId} onChange={(id) => { setDriverId(id); setFlash(null); setError(null); }} />
        <label className="flex flex-col gap-1"><span className="text-[12px] font-semibold text-muted">Огноо</span>
          <input type="date" value={date} onChange={(e) => { if (e.target.value) setDate(e.target.value); }} className="h-11 rounded-lg border border-line bg-surface px-2.5 text-[14px]" />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-semibold text-muted">Үйлдэл</span>
          <div className="flex flex-wrap gap-2">
            {h && canOperate ? (
              <>
                {h.status === 'DRAFT' ? <>
                  <Button variant="danger" loading={busy} onClick={() => { if (confirm(`${h.number} падааныг буцаах уу? (захиалгууд жолоочид оноосон хэвээр үлдэнэ)`)) run(() => api(`/api/handover/${h.id}`, { method: 'DELETE' }), 'Падаан буцаагдлаа'); }}>Падаан буцаах</Button>
                  <Button variant="dark" loading={busy} onClick={() => run(() => api(`/api/handover/${h.id}/prepare`, { method: 'POST', json: {} }), 'Бэлтгэсэн')}>Бэлтгэсэн</Button>
                </> : null}
                {h.status === 'PREPARED' ? <>
                  <Button loading={busy} onClick={() => run(() => api(`/api/handover/${h.id}/revert`, { method: 'POST', json: {} }), 'Ноорог болголоо (Check арилсан)')}>Буцаах</Button>
                  <Button variant="primary" loading={busy} disabled={h.totals.checked < h.totals.kinds} title={h.totals.checked < h.totals.kinds ? 'Бүх барааг Check хийнэ үү' : undefined}
                    className="!bg-ok !text-white" onClick={() => run(() => api(`/api/handover/${h.id}/confirm`, { method: 'POST', json: {} }), `${h.driverName}-д бараа өгөгдлөө — захиалгууд «Хүргэлтэд гарсан»`)}>✓ Барааг бүрэн өгсөн</Button>
                </> : null}
                {h.status === 'HANDED_OVER' ? <Button loading={busy} onClick={() => { if (confirm('Бараа жолоочоос агуулахад буцаж, захиалгууд «Жолоочид оноосон» болно. Үргэлжлүүлэх үү?')) run(() => api(`/api/handover/${h.id}/revert`, { method: 'POST', json: {} }), 'Буцаагдлаа — бараа агуулахад'); }}>Буцаах</Button> : null}
              </>
            ) : null}
            {h ? <a href={`/print/handover/${h.id}`} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center gap-1.5 rounded-[11px] border border-line bg-surface px-4 font-semibold"><Icon name="file" size={16} />Хэвлэх</a> : null}
          </div>
        </div>
      </div>

      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}
      {h && h.status !== 'DRAFT' && canOperate ? <p className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">⚠ {h.status === 'PREPARED' ? `${h.preparedBy ?? ''} бэлтгэсэн` : `${h.handedOverBy ?? ''} өгсөн`} — өөрчлөхөөс өмнө нягтална уу</p> : null}

      {!driverId ? <p className="rounded-xl border border-dashed border-line bg-surface p-10 text-center text-muted">Жолоочоо сонгоно уу</p>
        : !day ? <p className="py-8 text-center text-muted">Ачаалж байна…</p>
        : h ? <HandoverView h={h} short={short} canOperate={canOperate} onCheck={(variantId, checked) => run(() => api(`/api/handover/${h.id}/check`, { method: 'POST', json: { variantId, checked } }), checked ? 'Check' : 'Check арилгалаа')} busy={busy} />
        : (
          <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
            {!day.approval.approved ? <Notice>ХОРИГ — нягтлан зөвшөөрөл өгөөгүй{day.approval.note ? `: ${day.approval.note}` : ''}. Падаан үүсгэх боломжгүй.</Notice> : null}
            {!day.eligible.length ? <p className="py-6 text-center text-subtle">{drv?.name ?? 'Жолооч'}-д {date}-нд хуваарилсан захиалга алга</p> : <>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 font-semibold"><input type="checkbox" className="h-5 w-5" checked={sel.size === day.eligible.length} onChange={(e) => setSel(e.target.checked ? new Set(day.eligible.map((o) => o.id)) : new Set())} />Захиалга сонгох ({sel.size} сонгогдсон)</label>
                {canOperate ? <Button variant="primary" className="ml-auto" loading={busy} disabled={!day.approval.approved || !sel.size}
                  onClick={() => { if (sel.size < day.eligible.length) { setError(`Анхаар! ${day.eligible.length - sel.size} захиалга сонгоогүй байна — бүгдийг сонгоно уу`); return; } run(() => api('/api/handover', { method: 'POST', json: { driverId, date, orderIds: [...sel] } }), 'Падаан үүслээ'); }}>Падаан үүсгэх</Button> : null}
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {day.eligible.map((o) => (
                  <label key={o.id} className={clsx('flex cursor-pointer items-start gap-2 rounded-lg border p-2.5', sel.has(o.id) ? 'border-info bg-info-soft/40' : 'border-line')}>
                    <input type="checkbox" className="mt-0.5 h-5 w-5" checked={sel.has(o.id)} onChange={(e) => setSel((s) => { const x = new Set(s); if (e.target.checked) x.add(o.id); else x.delete(o.id); return x; })} />
                    <span className="flex min-w-0 flex-col"><b>№{o.number}</b><span className="text-muted">{o.phone} · {o.items}ш · {money(o.total)}</span>{o.note ? <OperatorNote text={o.note} /> : null}</span>
                  </label>
                ))}
              </div>
            </>}
          </div>
        )}
      <ApprovalsModal open={approvalsOpen} date={date} drivers={board?.drivers ?? []} onClose={() => setApprovalsOpen(false)} onChanged={() => { loadBoard(); loadDay(); }} />
    </div>
  );
}

/** Жолооч сонгох: хайлттай; OKEY/ХОРИГ, 🚚 захиалгын тоо, төлөв (Бэлдээгүй / Бэлдэж байна / Бэлдсэн / Өгсөн) */
function DriverPicker({ drivers, value, onChange }: { drivers: BDriver[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const cur = drivers.find((d) => d.id === value);
  const list = drivers.filter((d) => !q.trim() || d.name.toLowerCase().includes(q.trim().toLowerCase()) || d.phone.includes(q.trim())).sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name, 'mn'));
  return (
    <div ref={ref} className="relative flex flex-col gap-1">
      <span className="text-[12px] font-semibold text-muted">Жолооч</span>
      <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-11 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-left text-[14px]">
        {cur ? <DriverRow d={cur} /> : <span className="text-subtle">Жолооч сонгох…</span>}<Icon name="down" size={14} className="ml-auto" />
      </button>
      {open ? (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 rounded-xl border border-line bg-surface p-1.5 shadow-pop">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Хайх…" className="mb-1 h-9 w-full rounded-lg border border-line bg-surface2/60 px-2.5 text-[13px] outline-none" />
          <div className="max-h-[50vh] overflow-y-auto">
            {list.map((d) => <button key={d.id} type="button" onClick={() => { onChange(d.id); setOpen(false); setQ(''); }} className={clsx('flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface2', d.id === value && 'bg-surface2')}><DriverRow d={d} /></button>)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
function DriverRow({ d }: { d: BDriver }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="truncate font-semibold">{d.name}</span>
      <span className={clsx('rounded px-1.5 text-[10.5px] font-bold', d.approved ? 'bg-ok-soft text-ok-ink' : 'bg-bad-soft text-bad-ink')}>{d.approved ? 'OKEY' : 'ХОРИГ'}</span>
      <span className="text-[12px] text-muted">🚚 {d.orders}</span>
      <span className={clsx('ml-auto text-[11.5px] font-semibold', STATE_TONE[d.stateLabel])}>{d.stateLabel}</span>
    </span>
  );
}

/** Падаан: бараа нэгтгэсэн Check хүснэгт (тавиурын дарааллаар), явц, хайлт, «Шалгаагүй», хасагдсан/шинэ захиалга */
function HandoverView({ h, short, canOperate, onCheck, busy }: { h: Detail; short: { code: string; name: string; need: number; have: number }[]; canOperate: boolean; onCheck: (variantId: number, checked: boolean) => void; busy: boolean }) {
  const [q, setQ] = useState('');
  const [onlyUnchecked, setOnlyUnchecked] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const pct = h.totals.kinds ? Math.round((h.totals.checked / h.totals.kinds) * 100) : 0;
  const items = useMemo(() => h.items.filter((i) => (!onlyUnchecked || !i.checked) && (!q.trim() || `${i.code} ${i.name} ${i.label}`.toLowerCase().includes(q.trim().toLowerCase()))), [h.items, q, onlyUnchecked]);
  const removed = h.orders.filter((o) => o.removedAt);
  const added = h.orders.filter((o) => !o.removedAt && o.isNew);
  const locked = h.status === 'HANDED_OVER' || !canOperate;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px]">
        <b className="text-[15px]">{h.number}</b><span>Жолооч: <b>{h.driverName}</b></span><span>Огноо: <b>{h.date}</b></span>
        <span>{h.totals.orders} захиалга · {h.totals.pieces} ширхэг · <b>{money(h.totals.amount)}</b></span>
        <span className="text-subtle">Үүсгэсэн: {h.createdByName} {ubDateTime(h.createdAt)}</span>
        {h.handedOverAt ? <span className="text-ok-ink">Өгсөн: {h.handedOverBy} {ubDateTime(h.handedOverAt)}</span> : null}
      </div>
      {short.length && h.status !== 'HANDED_OVER' ? (
        <div className="rounded-xl border border-warn/40 bg-warn-soft p-3 text-warn">
          <p className="font-bold">⚠ Үндсэн агуулахад дутуу — «Дүүргэлт»-ээр татаж ирнэ үү</p>
          {short.map((s) => <p key={s.code} className="text-[12.5px]">{s.code} {s.name}: хэрэгтэй {s.need}, байгаа {s.have}</p>)}
        </div>
      ) : null}
      {removed.length ? (
        <div className="rounded-xl border border-bad/40 bg-bad-soft p-3 text-bad-ink">
          <p className="font-bold">⛔ Падаанаас хасагдсан — бараагаа тавиурт буцааж тавина уу</p>
          {removed.map((o) => <p key={o.orderId} className="text-[12.5px]">№{o.number} — {o.removeReason}: {o.lines.map((l) => `${l.name}${l.label ? ` · ${l.label}` : ''} ${l.qty}ш`).join(', ')}</p>)}
        </div>
      ) : null}
      {added.length ? <div className="rounded-xl border border-info/40 bg-info-soft p-3 text-info"><p className="font-bold">🆕 Шинээр нэмэгдсэн: {added.map((o) => `№${o.number}`).join(', ')} — барааг нь Check хийнэ үү</p></div> : null}

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3">
        <div className="flex min-w-[200px] flex-1 items-center gap-2">
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface2"><div className={clsx('h-full rounded-full', pct === 100 ? 'bg-ok' : 'bg-info')} style={{ width: `${pct}%` }} /></div>
          <span className="whitespace-nowrap font-bold">{h.totals.checked}/{h.totals.kinds} ({pct}%)</span>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Бараа хайх…" className="h-10 w-[200px] rounded-lg border border-line bg-surface2/60 px-2.5 text-[13px] outline-none" />
        <label className="flex items-center gap-2 font-semibold"><input type="checkbox" className="h-5 w-5" checked={onlyUnchecked} onChange={(e) => setOnlyUnchecked(e.target.checked)} />Шалгаагүй</label>
      </div>

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[640px] text-[14px]">
          <thead className="border-b border-line bg-surface2/70 text-[11.5px] uppercase text-muted">
            <tr><th className="px-3 py-2 text-left font-semibold">Бараа</th><th className="w-20 px-3 py-2 text-center font-semibold">Тоо</th><th className="w-24 px-3 py-2 text-center font-semibold">Check</th><th className="w-24 px-3 py-2 text-center font-semibold">Жолооч</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((i) => (
              <tr key={i.variantId} onClick={() => { if (!locked && !busy) onCheck(i.variantId, !i.checked); }} className={clsx(!locked && 'cursor-pointer', i.checked ? 'bg-ok-soft/40' : 'hover:bg-surface2/50')}>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-3">
                    <span onClick={(e) => e.stopPropagation()}>{i.thumb ? <ZoomButton images={[{ src: i.image ?? i.thumb, alt: i.name, name: i.code }]} label={`${i.name} — томруулах`}><Thumb src={i.thumb} alt={i.name} size={52} /></ZoomButton> : <Thumb src={null} alt={i.name} size={52} />}</span>
                    <span className="flex min-w-0 flex-col">
                      <span className="font-semibold">{i.name}{i.label ? <span className="text-muted"> · {i.label}</span> : null}</span>
                      <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-subtle">{i.code}{i.shelfCode ? <span className="rounded bg-ink px-1.5 font-bold text-on-ink">🗄 {i.shelfCode}</span> : null}<span>{money(i.amount)}</span></span>
                    </span>
                  </span>
                </td>
                <td className="px-3 py-2 text-center text-[18px] font-extrabold">{i.qty}</td>
                <td className="px-3 py-2 text-center">
                  <span className={clsx('inline-grid h-9 w-9 place-items-center rounded-lg border-2', i.checked ? 'border-ok bg-ok text-white' : 'border-line bg-surface')} title={i.checkedBy ? `Check: ${i.checkedBy}` : undefined}>{i.checked ? <Icon name="check" size={20} strokeWidth={3} /> : null}</span>
                </td>
                <td className="px-3 py-2 text-center text-[12px] text-subtle" title="Жолоочийн хүлээн авалт — Модуль 5">○</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length ? <p className="p-6 text-center text-subtle">{h.items.length ? 'Бүгд шалгагдсан' : 'Бараа алга'}</p> : null}
      </div>

      <div className="rounded-xl border border-line bg-surface">
        <button type="button" aria-expanded={ordersOpen} onClick={() => setOrdersOpen(!ordersOpen)} className="flex w-full items-center gap-1.5 px-3 py-2.5 font-semibold"><Icon name={ordersOpen ? 'up' : 'down'} size={14} />Захиалгууд ({h.totals.orders})</button>
        {ordersOpen ? (
          <ul className="divide-y divide-line border-t border-line">
            {h.orders.filter((o) => !o.removedAt).map((o) => (
              <li key={o.orderId} className="flex flex-col gap-0.5 px-3 py-2">
                <span className="flex flex-wrap items-center gap-2"><span className="text-subtle">#{o.position}</span><b>№{o.number}</b>{o.isNew ? <span className="rounded bg-info-soft px-1 text-[10.5px] font-bold text-info">ШИНЭ</span> : null}<span>{o.phone}</span><span className="ml-auto font-bold">{money(o.total)}</span></span>
                <span className="text-[12.5px] text-muted">{o.lines.map((l) => `${l.name}${l.label ? ` · ${l.label}` : ''} ${l.qty}ш`).join(', ')}</span>
                {o.note ? <OperatorNote text={o.note} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/** Нягтлангийн OKEY / ХОРИГ — өдөр бүр; «Итгэлтэй» жолооч автоматаар OKEY */
function ApprovalsModal({ open, date, drivers, onClose, onChanged }: { open: boolean; date: string; drivers: BDriver[]; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  async function save(json: Record<string, unknown>, id: string) {
    setBusy(id); setError(null);
    try { await api('/api/handover/approvals', { method: 'POST', json }); onChanged(); } catch (e) { setError(msg(e)); } finally { setBusy(null); }
  }
  return (
    <Modal open={open} onClose={onClose} size="xl" title={`Нягтлан OKEY / ХОРИГ · ${date}`} subtitle="ХОРИГ-той жолоочид падаан үүсэхгүй. «Итгэлтэй» жолооч өдөр бүр автоматаар OKEY.">
      <div className="mx-auto flex max-w-[860px] flex-col gap-2 text-[13px]">
        {error ? <Notice>{error}</Notice> : null}
        {drivers.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2.5">
            <span className="min-w-[160px] font-semibold">{d.name}</span>
            <span className={clsx('rounded px-1.5 text-[11px] font-bold', d.approved ? 'bg-ok-soft text-ok-ink' : 'bg-bad-soft text-bad-ink')}>{d.approved ? 'OKEY' : 'ХОРИГ'}</span>
            <span className="text-[11.5px] text-subtle">{d.approvalBy ?? ''}{d.approvalNote ? ` · ${d.approvalNote}` : ''}</span>
            <label className="ml-auto flex items-center gap-1.5 text-[12.5px]"><input type="checkbox" className="h-4 w-4" checked={d.trusted} disabled={busy === d.id} onChange={(e) => save({ driverId: d.id, trusted: e.target.checked }, d.id)} />Итгэлтэй</label>
            <input value={notes[d.id] ?? ''} onChange={(e) => setNotes({ ...notes, [d.id]: e.target.value })} placeholder="ХОРИГ-ийн шалтгаан (өр…)" className="h-8 w-[200px] rounded-md border border-line bg-surface px-2 text-[12.5px]" />
            <Button size="sm" variant="danger" loading={busy === d.id} onClick={() => save({ driverId: d.id, date, approved: false, note: notes[d.id] ?? '' }, d.id)}>ХОРИГ</Button>
            <Button size="sm" variant="dark" loading={busy === d.id} onClick={() => save({ driverId: d.id, date, approved: true }, d.id)}>OKEY</Button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
