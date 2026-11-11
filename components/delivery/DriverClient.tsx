'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';
import { OperatorNote } from '@/components/orders/OrdersClient';
import { money, ubDateTime } from '@/lib/format';

/**
 * Жолоочийн апп (Модуль 5, хуучин ERP-ийн урсгал): табууд Бүгд · Хүргэлт · Хүргэсэн · Цуцласан · Маргааш · Өчигдөр,
 * «Авах» (Pickup), «Миний бараа» (буцаах, нэмэлт бараа). Утсанд зориулсан — том товч, утас дарахад залгана.
 */
interface Line { id: number; variantId: number; code: string; name: string; label: string; thumb: string | null; qty: number; unitPrice: number; listPrice: number; refusedQty: number }
interface DOrder {
  id: number; number: string; status: string; statusLabel: string; phone: string; extraPhone: string | null; fullAddress: string; note: string | null;
  total: number; originalTotal: number | null; deliveryFee: number; prepaid: boolean; postponeCount: number; routeNo: number | null; deliveryDate: string; version: number;
  deliveryPayment: string | null; paymentLabel: string | null; collectAmount: number | null; deliveryNote: string | null;
  issueStatus: string | null; issueLabel: string | null; issueNote: string | null; issueResolveNote: string | null;
  cancelNote: string | null; fromPrevDay: boolean; goodsHidden?: boolean; postponedByName: string | null; driverName: string | null;
  lines: Line[];
  can: { deliver: boolean; cancel: boolean; postpone: boolean; postponeLocked: boolean; issue: boolean; undoDelivery: boolean; redeliver: boolean; undoPostpone: boolean };
}
interface ListResp { tab: string; today: string; counts: { delivery: number; delivered: number; cancelled: number; postponed: number; tomorrow: number }; money: { cash: number; bank: number; unpaid: number; prepaid: number }; items: DOrder[] }
interface GItem { variantId: number; code: string; name: string; label: string; thumb: string | null; balance: number; held: number; returnable: number }
interface GDoc { id: number; kind: string; kindLabel: string; at: string; byName: string; note: string | null; total: number; paymentLabel: string | null; lines: { variantId: number; name: string; label: string; qty: number; expected: number; unitPrice: number }[] }
interface GoodsResp { items: GItem[]; totals: { balance: number; returnable: number }; docs: GDoc[] }
interface PickOrder { id: number; number: string; fullAddress: string; deliveryDate: string; postponeCount: number; note: string | null }

const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const TABS: { k: string; l: string; c?: keyof ListResp['counts'] }[] = [
  { k: 'all', l: 'Бүгд' }, { k: 'delivery', l: 'Хүргэлт', c: 'delivery' }, { k: 'delivered', l: 'Хүргэсэн', c: 'delivered' },
  { k: 'cancelled', l: 'Цуцласан', c: 'cancelled' }, { k: 'tomorrow', l: 'Маргааш', c: 'tomorrow' }, { k: 'yesterday', l: 'Өчигдөр' }, { k: 'debts', l: 'Өрийн дэвтэр' },
];
const ST: Record<string, { l: string; c: string }> = {
  ASSIGNED: { l: 'БЭЛТГЭЖ БАЙНА', c: 'bg-surface2 text-muted' }, OUT_FOR_DELIVERY: { l: 'ХҮРГЭЛТЭНД', c: 'bg-info-soft text-info' },
  DELIVERED: { l: 'ХҮРГЭСЭН', c: 'bg-ok-soft text-ok-ink' }, CANCELLED: { l: 'ЦУЦАЛСАН', c: 'bg-bad-soft text-bad-ink' }, NEW: { l: 'МАРГААШ', c: 'bg-warn-soft text-warn' },
};

export function DriverClient() {
  const [main, setMain] = useState<'orders' | 'handover' | 'pickup' | 'goods'>('orders');
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const f = () => api<{ pending: number }>('/api/driver/handover').then((r) => setPending(r.pending)).catch(() => undefined);
    void f(); const t = setInterval(f, 30_000); return () => clearInterval(t);
  }, [main]);
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-[22px] font-extrabold tracking-tight">Миний хүргэлт</h1>
      </div>
      <div className="grid grid-cols-4 gap-1 rounded-[14px] bg-surface2 p-1" role="tablist">
        {([['orders', 'Захиалга'], ['handover', 'Падаан'], ['pickup', 'Авах'], ['goods', 'Миний бараа']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={main === k} onClick={() => setMain(k)}
            className={clsx('relative h-11 rounded-[11px] text-[13.5px] font-bold', main === k ? 'bg-surface text-ink shadow-card' : 'text-muted')}>
            {l}{k === 'handover' && pending ? <span className="absolute -right-0.5 -top-1 min-w-[18px] rounded-full bg-accent px-1 text-[11px] leading-[18px] text-on-accent">{pending}</span> : null}
          </button>
        ))}
      </div>
      {pending && main !== 'handover' ? (
        <button onClick={() => setMain('handover')} className="rounded-[14px] border-2 border-accent bg-accent-soft px-4 py-3 text-left text-[14.5px] font-bold text-accent-ink">
          📦 Агуулах бараа өгсөн — «Падаан» табаас барааг чагтлаад «Барааг бүрэн хүлээн авсан» дарна уу →
        </button>
      ) : null}
      {main === 'orders' ? <OrdersTab /> : main === 'handover' ? <HandoverTab onReceived={() => { setPending(0); setMain('orders'); }} /> : main === 'pickup' ? <PickupTab onTaken={() => setMain('orders')} /> : <GoodsTab />}
    </div>
  );
}

// ───────────────────────── Захиалга ─────────────────────────

function OrdersTab() {
  const [tab, setTab] = useState('all');
  const [data, setData] = useState<ListResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [dlg, setDlg] = useState<{ kind: 'deliver' | 'cancel' | 'postpone' | 'issue' | 'undo'; o: DOrder } | null>(null);
  const req = useRef(0);
  const load = useCallback(async () => {
    const id = ++req.current;
    if (tab === 'debts') return;
    try { const r = await api<ListResp>(`/api/driver/orders?tab=${tab}`); if (id === req.current) { setData(r); setError(null); } }
    catch (e) { if (id === req.current) setError(msg(e)); }
  }, [tab]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setInterval(() => void load(), 60_000); return () => clearInterval(t); }, [load]);

  async function act(o: DOrder, action: string, body: Record<string, unknown> = {}, done?: string) {
    await api(`/api/driver/orders/${o.id}/${action}`, { method: 'POST', json: { version: o.version, ...body } });
    setDlg(null); if (done) setFlash(done); await load();
  }

  const m = data?.money;
  return (
    <>
      {m ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MoneyTile l="Бэлэн" v={m.cash} tone="ok" /><MoneyTile l="Данс" v={m.bank} tone="info" />
          <MoneyTile l="Төлөөгүй (өрийн дэвтэрт)" v={m.unpaid} tone="bad" /><MoneyTile l="Урьдчилж төлсөн" v={m.prepaid} tone="muted" />
        </div>
      ) : null}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" data-overflow-ok>
        {TABS.map((t) => (
          <button key={t.k} role="tab" aria-selected={tab === t.k} onClick={() => setTab(t.k)}
            className={clsx('h-10 shrink-0 rounded-full border px-3.5 text-[13.5px] font-bold', tab === t.k ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-muted')}>
            {t.l}{t.c && data ? <span className="ml-1 opacity-75">{data.counts[t.c]}</span> : null}
          </button>
        ))}
      </div>
      {flash ? <div role="status" className="rounded-[12px] bg-ok-soft px-3 py-2 text-[14px] font-semibold text-ok-ink">{flash}</div> : null}
      {tab === 'debts' ? <DebtsTab /> : <>
      {error ? <Notice>{error}</Notice> : null}
      {data && !data.items.length ? <p className="rounded-[14px] border border-dashed border-line px-4 py-10 text-center text-muted">Захиалга алга</p> : null}
      <ul className="flex flex-col gap-3">
        {data?.items.map((o) => <OrderCard key={o.id} o={o} onAct={(kind) => setDlg({ kind, o })} onDirect={act} onRoute={load} />)}
      </ul>
      </>}
      {dlg?.kind === 'deliver' ? <DeliverModal o={dlg.o} onClose={() => setDlg(null)} onDone={(b) => act(dlg.o, 'deliver', b, `№${dlg.o.number} хүргэсэн`)} /> : null}
      {dlg?.kind === 'cancel' ? <CancelModal o={dlg.o} onClose={() => setDlg(null)} onDone={(b) => act(dlg.o, 'cancel', b, `№${dlg.o.number} цуцлагдлаа — бараагаа орой агуулахад буцаана`)} /> : null}
      {dlg?.kind === 'undo' ? <CancelModal o={dlg.o} undo onClose={() => setDlg(null)} onDone={(b) => act(dlg.o, 'undo-delivery', b, `№${dlg.o.number} буцаагдлаа — бараа танд`)} /> : null}
      {dlg?.kind === 'postpone' ? <PostponeModal o={dlg.o} onClose={() => setDlg(null)} onDone={() => act(dlg.o, 'postpone', {}, `№${dlg.o.number} маргааш болсон — бараагаа орой агуулахад буцаана`)} /> : null}
      {dlg?.kind === 'issue' ? <IssueModal o={dlg.o} onClose={() => setDlg(null)} onDone={(b) => act(dlg.o, 'issue', b, `№${dlg.o.number} Опп-руу явууллаа`)} /> : null}
    </>
  );
}

function MoneyTile({ l, v, tone }: { l: string; v: number; tone: 'ok' | 'info' | 'bad' | 'muted' }) {
  const c = { ok: 'text-ok-ink', info: 'text-info', bad: 'text-bad-ink', muted: 'text-muted' }[tone];
  return <div className="rounded-[12px] border border-line bg-surface px-3 py-2"><div className="text-[11.5px] font-semibold text-subtle">{l}</div><div className={clsx('text-[17px] font-extrabold', c)}>{money(v)}</div></div>;
}

function OrderCard({ o, onAct, onDirect, onRoute }: { o: DOrder; onAct: (k: 'deliver' | 'cancel' | 'postpone' | 'issue' | 'undo') => void; onDirect: (o: DOrder, a: string, b?: Record<string, unknown>, done?: string) => Promise<void>; onRoute: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const st = ST[o.status] ?? { l: o.statusLabel, c: 'bg-surface2 text-muted' };
  const run = async (a: string, done: string) => { setBusy(true); setErr(null); try { await onDirect(o, a, {}, done); } catch (e) { setErr(msg(e)); } finally { setBusy(false); } };
  async function saveRoute(v: string) {
    try { await api(`/api/driver/orders/${o.id}/route`, { method: 'POST', json: { routeNo: v === '' ? null : Number(v) } }); onRoute(); } catch (e) { setErr(msg(e)); }
  }
  const refused = o.lines.some((l) => l.refusedQty > 0);
  if (o.goodsHidden) {
    // Падаанаа хүлээн авахаас өмнө (хуучин шиг): зөвхөн дугаар, утас, хаяг, санамж
    return (
      <li className="flex flex-col gap-2.5 rounded-[16px] border border-line bg-surface p-3.5 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-[13px] font-bold text-subtle">#
            <input inputMode="numeric" defaultValue={o.routeNo ?? ''} aria-label="Дараалал" onBlur={(e) => { if (e.target.value !== String(o.routeNo ?? '')) void saveRoute(e.target.value); }}
              className="h-8 w-12 rounded-md border border-line bg-surface px-1.5 text-center text-[14px] font-bold text-ink" />
          </label>
          <span className="text-[16px] font-extrabold">№{o.number}</span>
          <span className="rounded-md bg-surface2 px-2 py-0.5 text-[11.5px] font-extrabold text-muted">БЭЛТГЭСЭН</span>
          <span className="text-[12.5px] text-subtle">{o.deliveryDate}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`tel:${o.phone}`} className="inline-flex h-11 items-center gap-2 rounded-[11px] bg-ok-soft px-3.5 text-[16px] font-extrabold text-ok-ink"><Icon name="phone" size={16} />{o.phone}</a>
          {o.extraPhone ? <a href={`tel:${o.extraPhone}`} className="inline-flex h-11 items-center gap-2 rounded-[11px] bg-surface2 px-3.5 text-[15px] font-bold"><Icon name="phone" size={15} />{o.extraPhone}</a> : null}
        </div>
        <p className="select-text text-[14px] leading-snug [overflow-wrap:anywhere]">📍 {o.fullAddress}</p>
        {o.note ? <OperatorNote text={o.note} className="!block text-[13px]" /> : null}
        <p className="rounded-[10px] bg-surface2 px-3 py-2 text-center text-[13px] text-muted">Барааг авснаас хойш бүх мэдээлэл харагдана</p>
        {err ? <Notice>{err}</Notice> : null}
      </li>
    );
  }
  return (
    <li className={clsx('flex flex-col gap-2.5 rounded-[16px] border bg-surface p-3.5 shadow-card', o.issueStatus === 'PENDING' ? 'border-warn' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2">
        {['ASSIGNED', 'OUT_FOR_DELIVERY'].includes(o.status) ? (
          <label className="flex items-center gap-1 text-[13px] font-bold text-subtle">#
            <input inputMode="numeric" defaultValue={o.routeNo ?? ''} aria-label="Дараалал" onBlur={(e) => { if (e.target.value !== String(o.routeNo ?? '')) void saveRoute(e.target.value); }}
              className="h-8 w-12 rounded-md border border-line bg-surface px-1.5 text-center text-[14px] font-bold text-ink" />
          </label>
        ) : null}
        <span className="text-[16px] font-extrabold">№{o.number}</span>
        <span className={clsx('rounded-md px-2 py-0.5 text-[11.5px] font-extrabold', st.c)}>{st.l}</span>
        {o.fromPrevDay ? <span className="rounded-md bg-bad-soft px-2 py-0.5 text-[11px] font-bold text-bad-ink">ӨМНӨХ ӨДРӨӨС</span> : null}
        {o.prepaid ? <span className="rounded-md bg-ok-soft px-2 py-0.5 text-[11px] font-bold text-ok-ink">Орсон</span> : null}
        {o.postponeCount ? <span className="rounded-md bg-warn-soft px-2 py-0.5 text-[11px] font-bold text-warn">Маргааш ×{o.postponeCount}</span> : null}
        <span className="ml-auto text-[17px] font-extrabold">{money(o.total)}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <a href={`tel:${o.phone}`} className="inline-flex h-11 items-center gap-2 rounded-[11px] bg-ok-soft px-3.5 text-[16px] font-extrabold text-ok-ink"><Icon name="phone" size={16} />{o.phone}</a>
        {o.extraPhone ? <a href={`tel:${o.extraPhone}`} className="inline-flex h-11 items-center gap-2 rounded-[11px] bg-surface2 px-3.5 text-[15px] font-bold"><Icon name="phone" size={15} />{o.extraPhone}</a> : null}
      </div>
      <p className="select-text text-[14px] leading-snug [overflow-wrap:anywhere]">📍 {o.fullAddress}</p>
      {o.note ? <OperatorNote text={o.note} className="!block text-[13px]" /> : null}
      {o.issueStatus === 'PENDING' ? <p className="rounded-[10px] bg-warn-soft px-3 py-2 text-[13px] font-semibold text-warn [overflow-wrap:anywhere]">⏳ «{o.issueLabel}» — ахлах оператор шийдвэрлэх хүртэл хүлээнэ үү{o.issueNote ? ` · ${o.issueNote}` : ''}</p> : null}
      {o.issueStatus === 'FIXED' ? <p className="rounded-[10px] bg-info-soft px-3 py-2 text-[13px] font-semibold text-info [overflow-wrap:anywhere]">✔ Асуудал зассан: {o.issueResolveNote}</p> : null}
      <ul className="flex flex-col gap-1.5 border-t border-line pt-2">
        {o.lines.map((l) => (
          <li key={l.id} className={clsx('flex items-center gap-2.5', l.refusedQty === l.qty && 'opacity-50')}>
            <Thumb src={l.thumb} alt={`${l.name} ${l.label}`} size={40} zoom={l.code} />
            <span className="min-w-0 flex-1 text-[13.5px] leading-tight [overflow-wrap:anywhere]"><b>{l.name}</b>{l.label ? <span className="text-muted"> · {l.label}</span> : null}<span className="block text-[12px] text-subtle">{l.code}</span></span>
            <span className="whitespace-nowrap text-right text-[13px]"><b>{l.qty}ш</b> × {money(l.unitPrice)}{l.refusedQty ? <span className="block text-[11.5px] font-bold text-bad-ink">Болиулсан {l.refusedQty}ш</span> : null}</span>
          </li>
        ))}
      </ul>
      {o.status === 'DELIVERED' ? <p className="text-[13px] text-muted">💰 {o.paymentLabel}{o.collectAmount ? ` · авсан ${money(o.collectAmount)}` : ''}{refused && o.originalTotal ? ` · анх ${money(o.originalTotal)}` : ''}{o.deliveryNote ? ` · ${o.deliveryNote}` : ''}</p> : null}
      {o.status === 'CANCELLED' && o.cancelNote ? <p className="text-[13px] text-bad-ink [overflow-wrap:anywhere]">Шалтгаан: {o.cancelNote}</p> : null}
      {o.status === 'NEW' ? <p className="text-[13px] text-warn">Маргааш болсон — бараагаа орой агуулахад буцаана</p> : null}
      {err ? <Notice>{err}</Notice> : null}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {o.can.deliver ? <Button variant="primary" size="lg" className="col-span-2 sm:col-span-1" onClick={() => onAct('deliver')}><Icon name="check" size={17} />Хүргэсэн</Button> : null}
        {o.can.postpone ? <Button size="lg" onClick={() => onAct('postpone')}>Маргааш</Button> : null}
        {o.can.postponeLocked ? <Button size="lg" disabled title="2 удаа хойшилсон — ахлах жолооч / оператор шийднэ"><Icon name="lock" size={15} />Цоожтой</Button> : null}
        {o.can.cancel ? <Button variant="danger" size="lg" onClick={() => onAct('cancel')}>Цуцлах</Button> : null}
        {o.can.issue ? <Button size="lg" onClick={() => onAct('issue')}>Опп-руу явуулах</Button> : null}
        {o.can.undoDelivery ? <Button variant="danger" onClick={() => onAct('undo')}>Цуцлах (буцаах)</Button> : null}
        {o.can.redeliver ? <Button onClick={() => onAct('deliver')}>Хүргэсэн болгох</Button> : null}
        {o.can.undoPostpone ? <Button loading={busy} onClick={() => run('undo-postpone', `№${o.number} буцаад танд`)}>«Маргааш»-ийг буцаах</Button> : null}
      </div>
    </li>
  );
}

function DeliverModal({ o, onClose, onDone }: { o: DOrder; onClose: () => void; onDone: (b: Record<string, unknown>) => Promise<void> }) {
  const [taken, setTaken] = useState<Record<number, number>>(() => Object.fromEntries(o.lines.map((l) => [l.id, l.qty])));
  const [pay, setPay] = useState<'CASH' | 'BANK' | 'UNPAID' | null>(null);
  const [paid, setPaid] = useState<boolean | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const total = useMemo(() => o.lines.reduce((n, l) => n + l.unitPrice * (taken[l.id] ?? 0), 0) + o.deliveryFee, [taken, o]);
  const anyTaken = Object.values(taken).some((q) => q > 0);
  const ready = anyTaken && (o.prepaid ? note.trim().length >= 5 : pay !== null);
  async function submit() {
    setBusy(true); setErr(null);
    try { await onDone({ taken, payment: o.prepaid ? undefined : pay, note }); } catch (e) { setErr(msg(e)); setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`№${o.number} хүргэсэн`} subtitle="Аваагүй барааны чагтыг авна уу"
      footer={<><Button variant="ghost" onClick={onClose}>Болих</Button><Button variant="primary" size="lg" loading={busy} disabled={!ready} onClick={submit}>Хүргэсэн · {money(total)}</Button></>}>
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-2">
          {o.lines.map((l) => {
            const q = taken[l.id] ?? 0;
            return (
              <li key={l.id} className={clsx('flex items-center gap-2.5 rounded-[12px] border p-2', q ? 'border-line' : 'border-bad/40 bg-bad-soft/40')}>
                <input type="checkbox" className="h-6 w-6 shrink-0 accent-[var(--accent)]" aria-label={`${l.name} авсан`} checked={q > 0} onChange={(e) => setTaken((t) => ({ ...t, [l.id]: e.target.checked ? l.qty : 0 }))} />
                <Thumb src={l.thumb} alt={l.name} size={40} />
                <span className="min-w-0 flex-1 text-[13.5px] leading-tight [overflow-wrap:anywhere]"><b>{l.name}</b>{l.label ? ` · ${l.label}` : ''}{!q ? <span className="block text-[12px] font-bold text-bad-ink">Болиулсан — танд үлдэнэ</span> : null}</span>
                {l.qty > 1 ? (
                  <span className="flex items-center gap-1">
                    <button type="button" aria-label="Хасах" className="h-9 w-9 rounded-lg border border-line text-[18px] font-bold" onClick={() => setTaken((t) => ({ ...t, [l.id]: Math.max(0, q - 1) }))}>−</button>
                    <span className="w-10 text-center text-[15px] font-extrabold">{q}/{l.qty}</span>
                    <button type="button" aria-label="Нэмэх" className="h-9 w-9 rounded-lg border border-line text-[18px] font-bold" onClick={() => setTaken((t) => ({ ...t, [l.id]: Math.min(l.qty, q + 1) }))}>+</button>
                  </span>
                ) : <span className="text-[14px] font-bold">{l.qty}ш</span>}
              </li>
            );
          })}
        </ul>
        {!anyTaken ? <Notice>Бүх барааг болиулсан бол «Цуцлах» дарна уу</Notice> : null}
        {o.prepaid ? (
          <label className="flex flex-col gap-1 text-[13.5px] font-semibold">Урьдчилж төлсөн — тайлбар (заавал)
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-autofocus className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[15px]" placeholder="Жишээ: Дансаар урьдчилж төлсөн" />
          </label>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-[15px] font-bold">Үйлчлүүлэгч мөнгөө өгсөн үү?</p>
            <div className="grid grid-cols-2 gap-2">
              <Button size="lg" variant={paid === true ? 'dark' : 'secondary'} onClick={() => { setPaid(true); setPay(null); }}>Төлсөн</Button>
              <Button size="lg" variant={paid === false ? 'danger' : 'secondary'} onClick={() => { setPaid(false); setPay('UNPAID'); }}>Төлөөгүй</Button>
            </div>
            {paid ? (
              <div className="grid grid-cols-2 gap-2">
                <Button size="lg" variant={pay === 'CASH' ? 'primary' : 'secondary'} onClick={() => setPay('CASH')}><Icon name="cash" size={16} />Бэлэн</Button>
                <Button size="lg" variant={pay === 'BANK' ? 'primary' : 'secondary'} onClick={() => setPay('BANK')}><Icon name="bank" size={16} />Данс</Button>
              </div>
            ) : null}
            {paid === false ? <p className="text-[13px] text-bad-ink">Таны «Өрийн дэвтэр»-т бичигдэнэ — үйлчлүүлэгч төлөхөд «Төлсөн» дарна</p> : null}
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Тэмдэглэл (заавал биш)" className="h-11 rounded-[10px] border border-line bg-surface px-3 text-[15px]" />
          </div>
        )}
        {err ? <Notice>{err}</Notice> : null}
      </div>
    </Modal>
  );
}

function CancelModal({ o, undo, onClose, onDone }: { o: DOrder; undo?: boolean; onClose: () => void; onDone: (b: Record<string, unknown>) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [bl, setBl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit() { setBusy(true); setErr(null); try { await onDone({ note, blacklist: bl }); } catch (e) { setErr(msg(e)); setBusy(false); } }
  return (
    <Modal open onClose={onClose} title={undo ? `№${o.number} — цуцлах (буцаах)` : `№${o.number} цуцлах`} subtitle={undo ? 'Бараа танд буцаж ирнэ, орой агуулахад өгнө' : 'Бараа танд үлдэж орой агуулахад буцаана'}
      footer={<><Button variant="ghost" onClick={onClose}>Болих</Button><Button variant="danger" size="lg" loading={busy} disabled={note.trim().length < 5} onClick={submit}>{undo ? 'Буцаах' : 'Цуцлах'}</Button></>}>
      <div className="flex flex-col gap-3">
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-autofocus placeholder="Шалтгаан бичих... (5+ тэмдэгт)" className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[15px]" />
        {!undo ? (
          <label className="flex items-center gap-2.5 text-[14px] font-semibold"><input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={bl} onChange={(e) => setBl(e.target.checked)} />Мөнгө өгдөггүй хүн (хар жагсаалтад)</label>
        ) : null}
        {err ? <Notice>{err}</Notice> : null}
      </div>
    </Modal>
  );
}

function PostponeModal({ o, onClose, onDone }: { o: DOrder; onClose: () => void; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title={`№${o.number} — маргааш`} subtitle={`${o.postponeCount + 1} дахь удаа (2 удаа хүртэл)`}
      footer={<><Button variant="ghost" onClick={onClose}>Болих</Button><Button variant="primary" size="lg" loading={busy} onClick={async () => { setBusy(true); setErr(null); try { await onDone(); } catch (e) { setErr(msg(e)); setBusy(false); } }}>Маргааш болгох</Button></>}>
      <ul className="flex flex-col gap-1.5 text-[14px] text-muted">
        <li>• Захиалга ижил дугаартай «Шинэ» болж, маргааш хүргэнэ — ахлах жолооч дахин хуваарилна.</li>
        {o.status === 'OUT_FOR_DELIVERY' ? <li>• <b className="text-ink">Бараа танд үлдэнэ — орой агуулахад заавал буцаана.</b></li> : null}
        <li>• Андуурсан бол өнөөдөр «Маргааш» табаас буцааж болно.</li>
      </ul>
      {err ? <div className="mt-3"><Notice>{err}</Notice></div> : null}
    </Modal>
  );
}

function IssueModal({ o, onClose, onDone }: { o: DOrder; onClose: () => void; onDone: (b: Record<string, unknown>) => Promise<void> }) {
  const [type, setType] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title={`№${o.number} — Опп-руу явуулах`} subtitle="Ахлах оператор шийдвэрлэх хүртэл захиалга түр зогсоно"
      footer={<><Button variant="ghost" onClick={onClose}>Болих</Button><Button variant="primary" size="lg" loading={busy} disabled={!type} onClick={async () => { setBusy(true); setErr(null); try { await onDone({ type, note }); } catch (e) { setErr(msg(e)); setBusy(false); } }}>Илгээх</Button></>}>
      <div className="flex flex-col gap-2">
        {([['WRONG_PRODUCT', 'Бараа буруу'], ['WRONG_NUMBER', 'Дугаар буруу'], ['UNCLEAR_ADDRESS', 'Хаяг тодорхойгүй']] as const).map(([k, l]) => (
          <Button key={k} size="lg" variant={type === k ? 'dark' : 'secondary'} onClick={() => setType(k)}>{l}</Button>
        ))}
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Тайлбар (заавал биш)" className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[15px]" />
        {err ? <Notice>{err}</Notice> : null}
      </div>
    </Modal>
  );
}

// ───────────────────────── Өрийн дэвтэр (жолоочийн хувийн, хуучин шиг) ─────────────────────────

interface Debt { id: number; number: string; phone: string; extraPhone: string | null; amount: number; createdAt: string; paidAt: string | null; fullAddress: string; lines: { id: number; name: string; label: string; code: string; thumb: string | null; qty: number; unitPrice: number }[] }

function DebtsTab() {
  const [paid, setPaid] = useState(false);
  const [d, setD] = useState<{ summary: { amount: number; count: number }; items: Debt[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const load = useCallback(async () => { try { setD(await api(`/api/driver/debts${paid ? '?paid=1' : ''}`)); setErr(null); } catch (e) { setErr(msg(e)); } }, [paid]);
  useEffect(() => { void load(); }, [load]);
  async function markPaid(x: Debt) {
    if (!confirm(`№${x.number} — үйлчлүүлэгч ${money(x.amount)} төлсөн үү?`)) return;
    setBusy(x.id); setErr(null);
    try { await api(`/api/driver/debts/${x.id}`, { method: 'POST', json: {} }); await load(); } catch (e) { setErr(msg(e)); } finally { setBusy(null); }
  }
  return (
    <div className="flex flex-col gap-3">
      {d ? (
        <div className="rounded-[14px] border border-bad/30 border-l-4 border-l-bad bg-surface px-4 py-3">
          <div className="flex items-center justify-between"><span className="text-[13px] font-semibold text-muted">Нийт өр:</span><span className="text-[22px] font-extrabold text-bad-ink">{money(d.summary.amount)}</span></div>
          <div className="text-[12px] text-subtle">{d.summary.count} захиалга · зөвхөн таны хувийн дэвтэр</div>
        </div>
      ) : null}
      <div className="flex gap-1.5">
        {([[false, 'Төлөөгүй'], [true, 'Төлсөн']] as const).map(([k, l]) => (
          <button key={l} onClick={() => setPaid(k)} className={clsx('h-9 rounded-full border px-3.5 text-[13px] font-bold', paid === k ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-muted')}>{l}</button>
        ))}
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {d && !d.items.length ? <p className="rounded-[14px] border border-dashed border-line px-4 py-10 text-center font-semibold text-ok-ink">{paid ? 'Төлсөн өр алга' : 'Өр байхгүй байна!'}</p> : null}
      <ul className="flex flex-col gap-2">
        {d?.items.map((x) => (
          <li key={x.id} className="flex flex-col gap-2 rounded-[14px] border border-line border-l-4 border-l-bad/70 bg-surface p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <b className="text-[15px]">№{x.number}</b>
                <div className="flex flex-wrap gap-2 pt-1">
                  <a href={`tel:${x.phone}`} className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-ok-soft px-3 text-[14px] font-bold text-ok-ink"><Icon name="phone" size={14} />{x.phone}</a>
                  {x.extraPhone ? <a href={`tel:${x.extraPhone}`} className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-surface2 px-3 text-[13.5px] font-bold"><Icon name="phone" size={14} />{x.extraPhone}</a> : null}
                </div>
                <p className="pt-1 text-[12.5px] text-muted [overflow-wrap:anywhere]">📍 {x.fullAddress}</p>
              </div>
              <div className="shrink-0 text-right"><div className="text-[17px] font-extrabold text-bad-ink">{money(x.amount)}</div><div className="text-[11.5px] text-subtle">{ubDateTime(x.createdAt)}</div></div>
            </div>
            {x.lines.length ? (
              <ul className="flex flex-col gap-1 border-t border-line pt-2">
                {x.lines.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 rounded-lg bg-surface2/60 p-1.5 text-[12.5px]">
                    <Thumb src={l.thumb} alt={l.name} size={30} zoom={l.code} />
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{l.name}{l.label ? ` · ${l.label}` : ''}<span className="block text-subtle">{l.qty} × {money(l.unitPrice)}</span></span>
                    <b className="whitespace-nowrap">{money(l.qty * l.unitPrice)}</b>
                  </li>
                ))}
              </ul>
            ) : null}
            {x.paidAt ? <p className="text-[12.5px] font-semibold text-ok-ink">✓ Төлсөн · {ubDateTime(x.paidAt)}</p>
              : <Button variant="primary" className="!bg-ok !text-white" loading={busy === x.id} onClick={() => markPaid(x)}><Icon name="check" size={15} />Төлсөн</Button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ───────────────────────── Падаан хүлээн авах ─────────────────────────

interface HItem { variantId: number; code: string; name: string; label: string; qty: number; amount: number; thumb: string | null; shelfCode: string | null; checked: boolean; driverChecked: boolean }
interface HDetail {
  id: number; number: string; date: string; status: 'DRAFT' | 'PREPARED' | 'HANDED_OVER' | 'RECEIVED'; handedOverAt: string | null; handedOverBy: string | null; receivedAt: string | null;
  totals: { orders: number; pieces: number; amount: number; kinds: number; driverChecked: number }; items: HItem[];
}

/** Хуучин ERP-ийн «Падаан хүлээн авах»: бараа нэгтгэсэн, тавиурын дарааллаар; агуулах Check хийсэн барааг жолооч чагтлаад «Барааг бүрэн хүлээн авсан» */
function HandoverTab({ onReceived }: { onReceived: () => void }) {
  const [d, setD] = useState<{ handover: HDetail | null } | null>(null);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState(false);
  const [busy, setBusy] = useState<number | 'all' | 'receive' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { try { setD(await api('/api/driver/handover')); setErr(null); } catch (e) { setErr(msg(e)); } }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15_000); return () => clearInterval(t); }, [load]);
  const h = d?.handover ?? null;
  async function check(variantId: number | 'all', checked: boolean) {
    if (!h) return;
    setBusy(variantId); setErr(null);
    try { const r = await api<{ handover: HDetail }>(`/api/driver/handover/${h.id}`, { method: 'POST', json: { action: 'check', variantId, checked } }); setD({ handover: r.handover }); }
    catch (e) { setErr(msg(e)); } finally { setBusy(null); }
  }
  async function receive() {
    if (!h) return;
    setBusy('receive'); setErr(null);
    try { await api(`/api/driver/handover/${h.id}`, { method: 'POST', json: { action: 'receive' } }); await load(); onReceived(); }
    catch (e) { setErr(msg(e)); setBusy(null); }
  }
  if (!d) return <p className="py-10 text-center text-muted">Ачаалж байна…</p>;
  if (!h) return <p className="rounded-[14px] border border-dashed border-line px-4 py-10 text-center text-muted">Энэ өдөр падаан байхгүй байна</p>;
  const items = h.items.filter((i) => (!only || !i.driverChecked) && (!q.trim() || `${i.code} ${i.name} ${i.label}`.toLowerCase().includes(q.trim().toLowerCase())));
  const all = h.totals.driverChecked === h.totals.kinds && h.totals.kinds > 0;
  const open = h.status === 'HANDED_OVER';
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-[12px] border border-line bg-surface px-3 py-2"><div className="text-[11.5px] font-semibold text-subtle">Падаан</div><div className="text-[15px] font-extrabold">{h.number}</div><div className="text-[11.5px] text-subtle">{h.date}</div></div>
        <div className="rounded-[12px] border border-line bg-surface px-3 py-2"><div className="text-[11.5px] font-semibold text-subtle">Захиалга</div><div className="text-[18px] font-extrabold">{h.totals.orders}</div><div className="text-[11.5px] text-subtle">{h.totals.pieces} ширхэг</div></div>
        <div className="col-span-2 rounded-[12px] border border-line bg-surface px-3 py-2 sm:col-span-1"><div className="text-[11.5px] font-semibold text-subtle">Падааны нийт дүн</div><div className="whitespace-nowrap text-[17px] font-extrabold">{money(h.totals.amount)}</div></div>
      </div>
      {h.status === 'DRAFT' ? <Notice tone="info">⏳ Агуулах бэлтгэж байна...</Notice> : null}
      {h.status === 'PREPARED' ? <Notice tone="info">📦 Агуулах бараа өгч байна...</Notice> : null}
      {h.status === 'RECEIVED' ? <Notice tone="ok">✓ Барааг бүрэн хүлээн авсан{h.receivedAt ? ` · ${ubDateTime(h.receivedAt)}` : ''}</Notice> : null}
      {open ? (
        <>
          <div className="h-2.5 overflow-hidden rounded-full bg-surface2"><div className="h-full rounded-full bg-ok" style={{ width: `${h.totals.kinds ? (h.totals.driverChecked / h.totals.kinds) * 100 : 0}%` }} /></div>
          <div className="flex flex-wrap items-center gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Бараа хайх..." className="h-10 min-w-0 flex-1 rounded-[10px] border border-line bg-surface px-3 text-[14px]" />
            <label className="flex items-center gap-1.5 text-[13px] font-semibold"><input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={only} onChange={(e) => setOnly(e.target.checked)} />Шалгаагүй</label>
            <Button size="sm" loading={busy === 'all'} onClick={() => check('all', !all)}>{all ? 'Бүгдийг болих' : 'Бүгд'}</Button>
          </div>
          <p className="text-[13px] font-semibold text-muted">Чагталсан {h.totals.driverChecked}/{h.totals.kinds} төрөл</p>
        </>
      ) : null}
      {err ? <Notice>{err}</Notice> : null}
      <ul className="flex flex-col gap-1.5">
        {items.map((i) => (
          <li key={i.variantId}>
            <label className={clsx('flex items-center gap-3 rounded-[14px] border bg-surface p-2.5', i.driverChecked ? 'border-ok/50 bg-ok-soft/40' : 'border-line', open && 'cursor-pointer')}>
              <input type="checkbox" className="h-7 w-7 shrink-0 accent-[var(--accent)]" aria-label={`${i.name} хүлээн авсан`} checked={i.driverChecked} disabled={!open || !i.checked || busy !== null}
                onChange={(e) => check(i.variantId, e.target.checked)} />
              <Thumb src={i.thumb} alt={i.name} size={46} zoom={i.code} />
              <span className="min-w-0 flex-1 text-[13.5px] leading-tight [overflow-wrap:anywhere]"><b>{i.name}</b>{i.label ? ` · ${i.label}` : ''}<span className="block text-[12px] text-subtle">{i.code}{i.shelfCode ? ` · ${i.shelfCode}` : ''}</span></span>
              <span className="text-right"><b className="block text-[20px] leading-none">{i.qty}</b><span className="text-[11px] text-subtle">ш</span></span>
            </label>
          </li>
        ))}
        {open && !items.length ? <li className="py-6 text-center text-muted">{only ? 'Бүх бараа шалгагдсан' : 'Хайлтад тохирох бараа олдсонгүй'}</li> : null}
      </ul>
      {open ? (
        <div className="sticky bottom-3 z-10 flex flex-col gap-1.5">
          {!all ? <p className="rounded-[10px] bg-surface/90 px-3 py-1.5 text-center text-[12.5px] text-muted">Дутуу бараа байвал агуулахад хэлнэ (тэд «Буцаах» дарж засна)</p> : null}
          <Button variant="primary" size="lg" className="w-full shadow-pop" disabled={!all} loading={busy === 'receive'} onClick={receive}>✓ Барааг бүрэн хүлээн авсан</Button>
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────── Авах (Pickup) ─────────────────────────

function PickupTab({ onTaken }: { onTaken: () => void }) {
  const [items, setItems] = useState<PickOrder[] | null>(null);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const r = await api<{ items: PickOrder[]; hasMore: boolean }>(`/api/driver/pickup?page=${page}`); setItems(r.items); setMore(r.hasMore); setErr(null); } catch (e) { setErr(msg(e)); }
  }, [page]);
  useEffect(() => { void load(); }, [load]);
  async function take() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ assigned: { number: string; date: string; movedNextDay: boolean }[]; skipped: { number: string; reason: string }[] }>('/api/driver/pickup', { method: 'POST', json: { ids: [...sel] } });
      setRes(`${r.assigned.length} захиалга авлаа${r.assigned.some((a) => a.movedNextDay) ? ' (падаан өгөгдсөн тул зарим нь маргааш)' : ''}${r.skipped.length ? ` · ${r.skipped.length} алгассан: ${r.skipped.map((s) => `№${s.number} ${s.reason}`).join(', ')}` : ''}`);
      setSel(new Set()); await load();
      if (r.assigned.length && !r.skipped.length) setTimeout(onTaken, 1200);
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <p className="text-[13px] text-muted">Хуваарилаагүй захиалга (өнөөдөр, маргааш). Сонгоод «Авах» — ахлах жолоочид харагдана.</p>
      {res ? <div role="status" className="rounded-[12px] bg-ok-soft px-3 py-2 text-[14px] font-semibold text-ok-ink [overflow-wrap:anywhere]">{res}</div> : null}
      {err ? <Notice>{err}</Notice> : null}
      {items && !items.length ? <p className="rounded-[14px] border border-dashed border-line px-4 py-10 text-center text-muted">Хуваарилаагүй захиалга алга</p> : null}
      <ul className="flex flex-col gap-2">
        {items?.map((o) => (
          <li key={o.id}>
            <label className={clsx('flex cursor-pointer gap-3 rounded-[14px] border bg-surface p-3', sel.has(o.id) ? 'border-accent bg-accent-soft/40' : 'border-line')}>
              <input type="checkbox" className="mt-1 h-6 w-6 shrink-0 accent-[var(--accent)]" checked={sel.has(o.id)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(o.id)) n.delete(o.id); else n.add(o.id); return n; })} />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2"><b className="text-[15px]">№{o.number}</b><span className="text-[12.5px] text-subtle">{o.deliveryDate}</span>{o.postponeCount ? <span className="rounded bg-warn-soft px-1.5 text-[11px] font-bold text-warn">Маргааш ×{o.postponeCount}</span> : null}</span>
                <span className="text-[13.5px] [overflow-wrap:anywhere]">📍 {o.fullAddress}</span>
                {o.note ? <OperatorNote text={o.note} className="!line-clamp-2" /> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Өмнөх</Button>
        <span className="text-[13px] text-muted">{page}-р хуудас</span>
        <Button size="sm" variant="ghost" disabled={!more} onClick={() => setPage((p) => p + 1)}>Дараах</Button>
      </div>
      {sel.size ? <div className="sticky bottom-3 z-10"><Button variant="primary" size="lg" className="w-full shadow-pop" loading={busy} onClick={take}>Сонгосныг авах ({sel.size})</Button></div> : null}
    </>
  );
}

// ───────────────────────── Миний бараа ─────────────────────────

function GoodsTab() {
  const [g, setG] = useState<GoodsResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dlg, setDlg] = useState<'take' | 'sale' | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const load = useCallback(async () => { try { setG(await api<GoodsResp>('/api/driver/goods')); setErr(null); } catch (e) { setErr(msg(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  const returnable = g?.items.filter((i) => i.returnable > 0) ?? [];
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-[14px] border border-line bg-surface p-3"><div className="text-[12px] font-semibold text-subtle">Гарт байгаа</div><div className="text-[24px] font-extrabold">{g?.totals.balance ?? '…'}<span className="text-[13px] font-semibold text-muted"> ш</span></div></div>
        <div className={clsx('rounded-[14px] border p-3', g?.totals.returnable ? 'border-warn bg-warn-soft' : 'border-line bg-surface')}><div className="text-[12px] font-semibold text-subtle">Агуулахад буцаах</div><div className="text-[24px] font-extrabold">{g?.totals.returnable ?? '…'}<span className="text-[13px] font-semibold text-muted"> ш</span></div></div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button size="lg" onClick={() => setDlg('take')}><Icon name="plus" size={16} />Нэмэлт бараа авах</Button>
        <Button size="lg" disabled={!returnable.length} onClick={() => setDlg('sale')}><Icon name="cash" size={16} />Нэмэлт бараа зарсан</Button>
      </div>
      {flash ? <div role="status" className="rounded-[12px] bg-ok-soft px-3 py-2 text-[14px] font-semibold text-ok-ink">{flash}</div> : null}
      {err ? <Notice>{err}</Notice> : null}
      {g && !g.items.length ? <p className="rounded-[14px] border border-dashed border-line px-4 py-8 text-center text-muted">Танд бараа алга</p> : null}
      <ul className="flex flex-col gap-2">
        {g?.items.map((i) => (
          <li key={i.variantId} className="flex items-center gap-3 rounded-[14px] border border-line bg-surface p-2.5">
            <Thumb src={i.thumb} alt={i.name} size={44} zoom={i.code} />
            <span className="min-w-0 flex-1 text-[13.5px] leading-tight [overflow-wrap:anywhere]"><b>{i.name}</b>{i.label ? ` · ${i.label}` : ''}<span className="block text-[12px] text-subtle">{i.code}</span></span>
            <span className="flex flex-col items-end text-[12.5px]">
              {i.held ? <span className="text-info">Хүргэлтэд <b>{i.held}</b></span> : null}
              {i.returnable ? <span className="font-bold text-warn">Буцаах {i.returnable}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {g?.docs.length ? (
        <section className="flex flex-col gap-1.5">
          <h2 className="text-[15px] font-extrabold">Сүүлийн баримт</h2>
          {g.docs.map((d) => (
            <div key={d.id} className="rounded-[12px] border border-line bg-surface px-3 py-2 text-[13px]">
              <div className="flex flex-wrap justify-between gap-2"><b>{d.kindLabel}</b><span className="text-subtle">{ubDateTime(d.at)} · {d.byName}</span></div>
              <div className="text-muted [overflow-wrap:anywhere]">{d.lines.map((l) => `${l.name}${l.label ? ` · ${l.label}` : ''} ${l.qty}ш${d.kind === 'RETURN' && l.expected > l.qty ? ` (дутуу ${l.expected - l.qty})` : ''}`).join(', ')}{d.total ? ` · ${money(d.total)} ${d.paymentLabel ?? ''}` : ''}</div>
            </div>
          ))}
        </section>
      ) : null}
      {dlg === 'take' ? <ExtraTakeModal onClose={() => setDlg(null)} onDone={async (t) => { setDlg(null); setFlash(t); await load(); }} /> : null}
      {dlg === 'sale' ? <ExtraSaleModal items={returnable} onClose={() => setDlg(null)} onDone={async (t) => { setDlg(null); setFlash(t); await load(); }} /> : null}
    </>
  );
}

interface Hit { variantId: number; variantCode: string; name: string; label: string; price: number; thumb: string | null; available: number }

function ExtraTakeModal({ onClose, onDone }: { onClose: () => void; onDone: (t: string) => Promise<void> }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [lines, setLines] = useState<(Hit & { qty: number })[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(newKey());
  useEffect(() => {
    if (q.trim().length < 1) { setHits([]); return; }
    const t = setTimeout(() => { api<{ items: Hit[] }>(`/api/products/search?q=${encodeURIComponent(q.trim())}&limit=10`).then((r) => setHits(r.items)).catch(() => undefined); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const add = (h: Hit) => { setLines((ls) => (ls.some((l) => l.variantId === h.variantId) ? ls : [...ls, { ...h, qty: 1 }])); setQ(''); setHits([]); };
  async function submit() {
    setBusy(true); setErr(null);
    try { await api('/api/driver/goods', { method: 'POST', json: { kind: 'take', idemKey: key.current, lines: lines.map((l) => ({ variantId: l.variantId, qty: l.qty })) } }); await onDone(`Нэмэлт бараа авлаа (${lines.reduce((n, l) => n + l.qty, 0)}ш)`); }
    catch (e) { setErr(msg(e)); setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Нэмэлт бараа авах" subtitle="Агуулахаас танд шилжинэ; зараагүйг буцаана"
      footer={<><Button variant="ghost" onClick={onClose}>Болих</Button><Button variant="primary" size="lg" loading={busy} disabled={!lines.length} onClick={submit}>Авах</Button></>}>
      <div className="flex flex-col gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} data-autofocus placeholder="Бараа хайх (код, нэр)" className="h-11 rounded-[10px] border border-line bg-surface px-3 text-[15px]" />
        {hits.length ? (
          <ul className="flex max-h-[240px] flex-col gap-1 overflow-y-auto rounded-[12px] border border-line p-1">
            {hits.map((h) => (
              <li key={h.variantId}><button type="button" disabled={h.available <= 0} onClick={() => add(h)} className="flex w-full items-center gap-2 rounded-lg p-1.5 text-left hover:bg-surface2 disabled:opacity-50">
                <Thumb src={h.thumb} alt={h.name} size={34} /><span className="min-w-0 flex-1 text-[13px] [overflow-wrap:anywhere]"><b>{h.name}</b>{h.label ? ` · ${h.label}` : ''}</span><span className="text-[12px] text-muted">боломжтой {h.available}</span>
              </button></li>
            ))}
          </ul>
        ) : null}
        {lines.map((l) => (
          <div key={l.variantId} className="flex items-center gap-2 rounded-[12px] border border-line p-2">
            <span className="min-w-0 flex-1 text-[13.5px] [overflow-wrap:anywhere]"><b>{l.name}</b>{l.label ? ` · ${l.label}` : ''}</span>
            <input inputMode="numeric" value={l.qty} aria-label="Тоо" onChange={(e) => setLines((ls) => ls.map((x) => (x.variantId === l.variantId ? { ...x, qty: Math.max(0, Math.min(l.available, Number(e.target.value.replace(/\D/g, '')) || 0)) } : x)))}
              className="h-10 w-16 rounded-lg border border-line bg-surface text-center text-[15px] font-bold" />
            <button type="button" aria-label="Хасах" onClick={() => setLines((ls) => ls.filter((x) => x.variantId !== l.variantId))} className="grid h-10 w-10 place-items-center rounded-lg text-subtle hover:bg-surface2"><Icon name="close" size={16} /></button>
          </div>
        ))}
        {err ? <Notice>{err}</Notice> : null}
      </div>
    </Modal>
  );
}

function ExtraSaleModal({ items, onClose, onDone }: { items: GItem[]; onClose: () => void; onDone: (t: string) => Promise<void> }) {
  const [qty, setQty] = useState<Record<number, number>>({});
  const [pay, setPay] = useState<'CASH' | 'BANK' | 'UNPAID' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(newKey());
  const lines = Object.entries(qty).filter(([, q]) => q > 0).map(([v, q]) => ({ variantId: Number(v), qty: q }));
  async function submit() {
    setBusy(true); setErr(null);
    try { const r = await api<{ doc: { total: number } }>('/api/driver/goods', { method: 'POST', json: { kind: 'sale', idemKey: key.current, payment: pay, note, lines } }); await onDone(`Зарсан: ${money(r.doc.total)} (системийн үнээр)`); }
    catch (e) { setErr(msg(e)); setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Нэмэлт бараа зарсан" subtitle="Үнэ системийн үнээр бодогдоно"
      footer={<><Button variant="ghost" onClick={onClose}>Болих</Button><Button variant="primary" size="lg" loading={busy} disabled={!lines.length || !pay} onClick={submit}>Бүртгэх</Button></>}>
      <div className="flex flex-col gap-2">
        {items.map((i) => (
          <div key={i.variantId} className="flex items-center gap-2 rounded-[12px] border border-line p-2">
            <Thumb src={i.thumb} alt={i.name} size={36} />
            <span className="min-w-0 flex-1 text-[13.5px] [overflow-wrap:anywhere]"><b>{i.name}</b>{i.label ? ` · ${i.label}` : ''}<span className="block text-[12px] text-subtle">танд {i.returnable}</span></span>
            <input inputMode="numeric" value={qty[i.variantId] ?? 0} aria-label="Зарсан тоо" onChange={(e) => setQty((q) => ({ ...q, [i.variantId]: Math.max(0, Math.min(i.returnable, Number(e.target.value.replace(/\D/g, '')) || 0)) }))}
              className="h-10 w-16 rounded-lg border border-line bg-surface text-center text-[15px] font-bold" />
          </div>
        ))}
        <div className="grid grid-cols-3 gap-2">
          {([['CASH', 'Бэлэн'], ['BANK', 'Данс'], ['UNPAID', 'Төлөөгүй']] as const).map(([k, l]) => <Button key={k} variant={pay === k ? 'primary' : 'secondary'} onClick={() => setPay(k)}>{l}</Button>)}
        </div>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Тэмдэглэл (утас, хэнд)" className="h-11 rounded-[10px] border border-line bg-surface px-3 text-[15px]" />
        {err ? <Notice>{err}</Notice> : null}
      </div>
    </Modal>
  );
}
