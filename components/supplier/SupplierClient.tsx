'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Badge } from '@/components/ui/Badge';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';

/**
 * Нийлүүлэгч (Модуль 7в, хуучин «Гадны дэлгүүр удирдлага»): самбар → дэлгүүр → өдрийн тооцоо (падааны өдрөөр),
 * нэгтгэл, шилжүүлсэн, бараа + суутгал, буцаалт/нэмэгдэл (шалтгаантай), нэвтрэх эрх. Нийлүүлэгч өөрөө зөвхөн өөрийнхийг харна.
 */
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const ubToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const digits = (s: string) => s.replace(/\D/g, '').slice(0, 9);
const inputCls = 'h-10 min-w-0 rounded-[10px] border border-line bg-surface px-2.5 text-[13.5px]';

interface OrderDay { label: string; date: string; total: number; delivered: number; cancelled: number; onRoad: number; pending: number; amount: number; shops?: { id: number; name: string; total: number; amount: number }[] }
interface ShopRow { id: number; name: string; contactName: string; contactPhone: string; isActive: boolean; hasLogin: boolean; productCount: number; openDays: number; balance: number; pendingAdj: number; monthSales: number }
interface Overview { stats: { activeShops: number; monthSales: number; monthNet: number; todaySales: number; todayNet: number; balance: number }; orderDays: OrderDay[]; shops: ShopRow[]; isSuperAdmin: boolean; defaults: Ded }
interface Ded { operatorCost: number; deliveryCost: number; marketingCost: number; otherCost: number; otherNote: string }
interface Prod { id: number; productId: number; code: string; name: string; fromDate: string; toDate: string | null; active: boolean; createdByName: string; endedByName: string | null; deduction: Ded }
interface Adj { id: number; kind: string; kindLabel: string; sourceDate: string | null; orderNumber: string | null; productName: string | null; qty: number; sales: number; deduction: number; amount: number; reason: string; createdAt: string; appliedDate: string | null }
interface RangeDay { date: string; status: string; qty: number; sales: number; deductions: number; net: number; adjustments: number; payable: number; unfinished: number }
interface Detail {
  shop: { id: number; name: string; contactName: string; contactPhone: string; isActive: boolean; version: number };
  admin: boolean; isSuperAdmin: boolean; today: string; products: Prod[]; defaults: Ded | null;
  balance: { openDays: number; openNet: number; pendingAdj: number; pendingAdjCount: number; balance: number };
  openDays: RangeDay[]; transferredDays: RangeDay[]; adjustments: Adj[]; orderDays: OrderDay[];
  login: { id: string; name: string; phone: string; isActive: boolean; lastLoginAt: string | null } | null;
}
interface Line { productId: number; code: string; name: string; qty: number; cancelledQty: number; unitPrice: number; sales: number; operatorCost: number; deliveryCost: number; marketingCost: number; otherCost: number; otherNote: string; deduction: number; net: number; manual: boolean; manualNote: string }
interface Day { shopId: number; date: string; status: 'OPEN' | 'TRANSFERRED'; lines: Line[]; totals: { qty: number; cancelledQty: number; sales: number; deductions: number; net: number }; unfinished: number; adjustments: Adj[]; adjTotal: number; payable: number; carry: number; transferredAt: string | null; transferredByName: string | null; version: number; laterChanges?: Adj[] }

export function SupplierClient({ admin }: { admin: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!admin) return <ShopPanel shopId={null} />;
  if (open !== null) return <ShopPanel shopId={open} onBack={() => setOpen(null)} />;
  return <AdminOverview onOpen={setOpen} />;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'accent' | 'ok' | 'bad' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-2xl border border-line bg-surface px-4 py-3">
      <span className="text-[12.5px] font-semibold text-muted">{label}</span>
      <b className={clsx('break-words text-[17px] font-extrabold tracking-tight sm:text-[22px]', tone === 'accent' && 'text-accent', tone === 'ok' && 'text-ok-ink', tone === 'bad' && 'text-bad-ink')}>{value}</b>
    </div>
  );
}

function OrderDays({ days, all }: { days: OrderDay[]; all?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12.5px] text-muted">
        <b className="text-ink">{all ? 'Нийт захиалга' : 'Захиалга (энэ нийлүүлэгчийн бараатай)'}</b> — Улаанбаатарын 00:00-аас; урьдчилж төлсөн нь мөнгө орсон өдөрт.
        Төлбөр хүлээж буй, жолоочид гараагүй цуцлагдсан, он сар өдөртэй захиалга тоологдохгүй. Тооцоо харин <b className="text-ink">падааны өдрөөр</b>.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {days.map((d) => (
          <div key={d.date} className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
            <div className="flex items-baseline justify-between gap-2"><b className="text-[14px]">{d.label}</b><span className="text-[12.5px] text-subtle">{d.date.slice(5).replace('-', '/')}</span></div>
            <div className="text-[24px] font-extrabold tracking-tight">{d.total} <span className="text-[13px] font-medium text-muted">захиалга · {money(d.amount)}</span></div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px] text-muted">
              <span>Хүргэсэн: <b className="text-ok-ink">{d.delivered}</b></span><span>Хүргэлтэд: <b className="text-ink">{d.onRoad}</b></span>
              <span>Хүлээгдэж: <b className="text-ink">{d.pending}</b></span><span>Цуцалсан: <b className="text-bad-ink">{d.cancelled}</b></span>
            </div>
            {d.shops?.length ? (
              <div className="flex flex-col gap-1 border-t border-line pt-2 text-[12.5px]">
                {d.shops.map((x) => (
                  <div key={x.id} className="flex min-w-0 items-baseline justify-between gap-2">
                    <span className="min-w-0 break-words text-muted">{x.name}</span>
                    <b className="shrink-0">{x.total} · {money(x.amount)}</b>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminOverview({ onOpen }: { onOpen: (id: number) => void }) {
  const [d, setD] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [add, setAdd] = useState(false);
  const [defs, setDefs] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const load = useCallback(async () => { try { setD(await api('/api/supplier')); setErr(null); } catch (e) { setErr(msg(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0"><h1 className="text-[24px] font-extrabold tracking-tight">Нийлүүлэгч</h1><p className="text-[13.5px] text-muted">Гадны дэлгүүрийн бараа · падааны өдрөөр тооцоо · борлуулалт − суутгал = шилжүүлэх дүн</p></div>
        <div className="flex flex-wrap gap-2">
          {d?.isSuperAdmin ? <Button size="sm" onClick={() => setDefs(true)}>Анхдагч суутгал</Button> : null}
          <Button variant="primary" size="sm" onClick={() => setAdd(true)}>+ Дэлгүүр нэмэх</Button>
        </div>
      </div>
      {d ? <p className="min-w-0 break-words text-[13px] text-muted">Бараа нэмэхэд автоматаар тавигдах суутгал (1 ширхэгээс): {dedText(d.defaults)}</p> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
      {err ? <Notice>{err}</Notice> : null}
      {d ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Идэвхтэй дэлгүүр" value={String(d.stats.activeShops)} />
            <Stat label="Энэ сарын борлуулалт" value={money(d.stats.monthSales)} />
            <Stat label="Өнөөдрийн борлуулалт" value={money(d.stats.todaySales)} />
            <Stat label="Нийт төлөх үлдэгдэл" value={money(d.stats.balance)} tone="accent" />
          </div>
          <OrderDays days={d.orderDays} all />
          <div className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface">
            {d.shops.length === 0 ? <p className="p-6 text-center text-[14px] text-muted">Дэлгүүр бүртгэгдээгүй — «+ Дэлгүүр нэмэх»</p> : null}
            {d.shops.map((s) => (
              <button key={s.id} type="button" data-shop-open={s.id} onClick={() => onOpen(s.id)}
                className="flex min-w-0 flex-col gap-2 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-surface2 sm:flex-row sm:items-center sm:gap-4">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2"><b className="min-w-0 break-words text-[15px]">{s.name}</b>{s.isActive ? null : <Badge tone="bad">Идэвхгүй</Badge>}{s.hasLogin ? <Badge>Нэвтрэх эрхтэй</Badge> : null}</div>
                  <span className="min-w-0 break-words text-[12.5px] text-muted">{[s.contactName, s.contactPhone].filter(Boolean).join(' · ') || '—'} · {s.productCount} бараа · энэ сар {money(s.monthSales)}</span>
                </div>
                <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end sm:gap-0.5">
                  <b className="text-[16px]">{money(s.balance)}</b>
                  <span className="text-[12px] text-muted">{s.openDays ? `${s.openDays} өдөр шилжүүлээгүй` : 'Бүгд шилжүүлсэн'}{s.pendingAdj ? ` · буцаалт ${money(s.pendingAdj)}` : ''}</span>
                </div>
              </button>
            ))}
          </div>
        </>
      ) : null}
      {add ? <ShopDialog onClose={() => setAdd(false)} onDone={async (id) => { setAdd(false); await load(); onOpen(id); }} /> : null}
      {defs && d ? <DefaultsDialog value={d.defaults} onClose={() => setDefs(false)} onDone={async (m) => { setDefs(false); setOk(m); await load(); }} /> : null}
    </div>
  );
}

const dedText = (x: Ded) => `Опп ${money(x.operatorCost)} · Хүргэлт ${money(x.deliveryCost)} · Маркетинг ${money(x.marketingCost)} · Бусад ${money(x.otherCost)}${x.otherNote ? ` (${x.otherNote})` : ''} = ${money(x.operatorCost + x.deliveryCost + x.marketingCost + x.otherCost)}`;

function DefaultsDialog({ value, onClose, onDone }: { value: Ded; onClose: () => void; onDone: (m: string) => void }) {
  const [v, setV] = useState({ operatorCost: String(value.operatorCost), deliveryCost: String(value.deliveryCost), marketingCost: String(value.marketingCost), otherCost: String(value.otherCost), otherNote: value.otherNote });
  const [all, setAll] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const f = (k: keyof typeof v, label: string) => (
    <label className="flex min-w-0 flex-col gap-1 text-[12.5px] font-semibold text-muted">{label}<input value={v[k]} inputMode="numeric" onChange={(e) => setV({ ...v, [k]: digits(e.target.value) })} className={clsx(inputCls, 'text-right')} /></label>
  );
  const save = async () => {
    if (all && !confirm('Одоо оноогдсон БҮХ барааны суутгалыг энэ дүнгээр солих уу? (Шилжүүлсэн өдрүүд өөрчлөгдөхгүй)')) return;
    try { const r = await api<{ updated: number }>('/api/supplier', { method: 'POST', json: { action: 'defaults', ...v, applyAll: all } }); onDone(all ? `Анхдагч хадгалагдлаа · ${r.updated} барааны суутгал шинэчлэгдлээ` : 'Анхдагч суутгал хадгалагдлаа (шинэ бараанд)'); } catch (e) { setErr(msg(e)); }
  };
  return (
    <Modal open onClose={onClose} title="Анхдагч суутгал (1 ширхэгээс)" subtitle="Бүх дэлгүүрт нэг · бараа нэмэхэд автоматаар тавигдана · зөвхөн Супер админ"
      footer={<><Button onClick={onClose}>Болих</Button><Button variant="primary" onClick={() => void save()}>Хадгалах</Button></>}>
      <div className="flex flex-col gap-3">
        {err ? <Notice>{err}</Notice> : null}
        <div className="grid grid-cols-2 gap-3">
          {f('operatorCost', 'Опп зардал')}{f('deliveryCost', 'Хүргэлт')}{f('marketingCost', 'Маркетинг')}{f('otherCost', 'Бусад')}
          <label className="col-span-2 flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Бусдын тайлбар<input value={v.otherNote} onChange={(e) => setV({ ...v, otherNote: e.target.value })} className={inputCls} /></label>
        </div>
        <label className="flex items-start gap-2 text-[13.5px]"><input type="checkbox" className="mt-1" checked={all} onChange={(e) => setAll(e.target.checked)} /><span>Одоо байгаа бүх барааны суутгалыг ч шинэчлэх <span className="text-muted">(чагтлаагүй бол зөвхөн шинээр нэмэх бараанд)</span></span></label>
      </div>
    </Modal>
  );
}

function ShopDialog({ shop, onClose, onDone }: { shop?: Detail['shop']; onClose: () => void; onDone: (id: number) => void }) {
  const [name, setName] = useState(shop?.name ?? '');
  const [cn, setCn] = useState(shop?.contactName ?? '');
  const [cp, setCp] = useState(shop?.contactPhone ?? '');
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try { const r = await api<{ id: number }>('/api/supplier', { method: 'POST', json: { action: 'shop', id: shop?.id, version: shop?.version, name, contactName: cn, contactPhone: cp } }); onDone(r.id); } catch (e) { setErr(msg(e)); }
  };
  return (
    <Modal open onClose={onClose} title={shop ? 'Дэлгүүр засах' : 'Шинэ дэлгүүр'} footer={<><Button onClick={onClose}>Болих</Button><Button variant="primary" onClick={() => void save()}>Хадгалах</Button></>}>
      <div className="flex flex-col gap-3">
        {err ? <Notice>{err}</Notice> : null}
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-muted">Дэлгүүрийн нэр<input data-autofocus value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></label>
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-muted">Холбогдох хүн<input value={cn} onChange={(e) => setCn(e.target.value)} className={inputCls} /></label>
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-muted">Утас<input value={cp} inputMode="tel" onChange={(e) => setCp(e.target.value)} className={inputCls} /></label>
      </div>
    </Modal>
  );
}

type Tab = 'day' | 'range' | 'done' | 'products' | 'adj' | 'login';

function ShopPanel({ shopId, onBack }: { shopId: number | null; onBack?: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>('day');
  const [date, setDate] = useState(ubToday());
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const q = shopId === null ? 'me=1' : `shop=${shopId}`;
  const load = useCallback(async () => { try { setD(await api(`/api/supplier?${q}`)); setErr(null); } catch (e) { setErr(msg(e)); } }, [q]);
  useEffect(() => { void load(); }, [load]);
  const post = async (json: Record<string, unknown>, m?: string) => {
    try { const r = await api<Record<string, unknown>>('/api/supplier', { method: 'POST', json: { shopId, ...json } }); if (m) setOk(m); setErr(null); await load(); return r; } catch (e) { setErr(msg(e)); setOk(null); return null; }
  };
  if (!d) return <div className="flex flex-col gap-3">{err ? <Notice>{err}</Notice> : <p className="text-muted">Ачаалж байна…</p>}</div>;
  const tabs: [Tab, string][] = [['day', 'Өдрийн тооцоо'], ['range', 'Нэгтгэл'], ['done', 'Шилжүүлсэн'], ...(d.admin ? [['products', `Бараа (${d.products.filter((p) => p.active).length})`] as [Tab, string]] : []),
    ['adj', `Буцаалт${d.balance.pendingAdjCount ? ` (${d.balance.pendingAdjCount})` : ''}`], ...(d.admin ? [['login', 'Нэвтрэх эрх'] as [Tab, string]] : [])];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          {onBack ? <button type="button" onClick={onBack} className="self-start text-[13px] font-semibold text-accent">← Бүх дэлгүүр</button> : null}
          <h1 className="min-w-0 break-words text-[24px] font-extrabold tracking-tight">{d.shop.name}</h1>
          <p className="min-w-0 break-words text-[13.5px] text-muted">{[d.shop.contactName, d.shop.contactPhone].filter(Boolean).join(' · ') || (d.admin ? 'Холбогдох мэдээлэлгүй' : 'Тооцооны самбар')}{d.shop.isActive ? '' : ' · Идэвхгүй'}</p>
        </div>
        {d.admin ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setEdit(true)}>Засах</Button>
            <Button size="sm" onClick={() => { if (confirm(d.shop.isActive ? 'Дэлгүүрийг идэвхгүй болгох уу? Нийлүүлэгч нэвтрэх боломжгүй болно.' : 'Идэвхжүүлэх үү?')) void post({ action: 'active', active: !d.shop.isActive }, 'Хадгаллаа'); }}>{d.shop.isActive ? 'Идэвхгүй болгох' : 'Идэвхжүүлэх'}</Button>
          </div>
        ) : null}
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-semibold text-muted">{d.admin ? 'Нийлүүлэгчид төлөх үлдэгдэл' : 'Таны авах үлдэгдэл'}</span>
          <b className="text-[28px] font-extrabold tracking-tight text-accent">{money(d.balance.balance)}</b>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] text-muted">
          <span>Шилжүүлээгүй өдөр</span><b className="text-right text-ink">{d.balance.openDays} · {money(d.balance.openNet)}</b>
          <span>Буцаалт / нэмэгдэл</span><b className={clsx('text-right', d.balance.pendingAdj < 0 ? 'text-bad-ink' : 'text-ink')}>{money(d.balance.pendingAdj)}</b>
        </div>
      </div>
      <OrderDays days={d.orderDays} />
      <div className="flex gap-1 overflow-x-auto rounded-xl bg-surface2 p-1">
        {tabs.map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={clsx('shrink-0 rounded-lg px-3.5 py-2 text-[13.5px] font-semibold', tab === k ? 'bg-surface text-ink shadow-sm' : 'text-muted')}>{l}</button>
        ))}
      </div>
      {tab === 'day' ? <DayTab detail={d} date={date} setDate={setDate} q={q} post={post} /> : null}
      {tab === 'range' ? <RangeTab q={q} onPick={(x) => { setDate(x); setTab('day'); }} /> : null}
      {tab === 'done' ? <DaysList days={d.transferredDays} empty="Сүүлийн 90 хоногт шилжүүлсэн тооцоо алга" onPick={(x) => { setDate(x); setTab('day'); }} /> : null}
      {tab === 'products' && d.admin ? <ProductsTab d={d} post={post} /> : null}
      {tab === 'adj' ? <AdjList list={d.adjustments} empty="Буцаалт, нэмэгдэл алга" /> : null}
      {tab === 'login' && d.admin ? <LoginTab d={d} post={post} /> : null}
      {edit ? <ShopDialog shop={d.shop} onClose={() => setEdit(false)} onDone={async () => { setEdit(false); setOk('Хадгаллаа'); await load(); }} /> : null}
    </div>
  );
}

type Post = (json: Record<string, unknown>, m?: string) => Promise<Record<string, unknown> | null>;

function DayTab({ detail, date, setDate, q, post }: { detail: Detail; date: string; setDate: (s: string) => void; q: string; post: Post }) {
  const [day, setDay] = useState<Day | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ov, setOv] = useState<Line | null>(null);
  const load = useCallback(async () => { try { setDay(await api(`/api/supplier?${q}&day=${date}`)); setErr(null); } catch (e) { setErr(msg(e)); } }, [q, date]);
  useEffect(() => { void load(); }, [load, detail]);
  const locked = day?.status === 'TRANSFERRED';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={date} max={detail.today} onChange={(e) => e.target.value && setDate(e.target.value)} className={inputCls} aria-label="Падааны өдөр" />
        <span className="text-[12.5px] text-subtle">Падааны өдөр</span>
        {detail.openDays.length ? (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {detail.openDays.slice(0, 8).map((o) => (
              <button key={o.date} type="button" onClick={() => setDate(o.date)} className={clsx('rounded-full border px-2.5 py-1 text-[12px] font-semibold', o.date === date ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted')}>{o.date.slice(5)} · {money(o.net)}</button>
            ))}
          </div>
        ) : null}
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {day ? (
        <>
          {locked ? <Notice tone="ok">🔒 Шилжүүлсэн · {day.transferredByName} · {ubDateTime(day.transferredAt)} — энэ өдрийн дүн өөрчлөгдөхгүй.</Notice> : null}
          {!locked && day.unfinished > 0 ? <Notice tone="warn">Энэ падааны {day.unfinished} захиалга дуусаагүй (хүргэлтэд эсвэл хүлээн аваагүй) — бүгд дууссаны дараа шилжүүлнэ.</Notice> : null}
          {day.lines.length === 0 ? <p className="rounded-2xl border border-line bg-surface p-6 text-center text-[14px] text-muted">Энэ өдөр борлуулалт бүртгэгдээгүй</p> : (
            <>
              <div className="hidden overflow-x-auto rounded-2xl border border-line bg-surface md:block">
                <table className="w-full min-w-[860px] text-[13.5px]">
                  <thead><tr className="bg-surface2 text-left text-[12px] text-muted">
                    <th className="px-3 py-2">Бараа</th><th className="px-2 py-2 text-right">Хүргэсэн</th><th className="px-2 py-2 text-right">Цуцалсан</th><th className="px-2 py-2 text-right">Борлуулалт</th>
                    <th className="px-2 py-2 text-right">Опп</th><th className="px-2 py-2 text-right">Хүргэлт</th><th className="px-2 py-2 text-right">Маркетинг</th><th className="px-2 py-2 text-right">Бусад</th><th className="px-3 py-2 text-right">Цэвэр</th>
                    {detail.isSuperAdmin && !locked ? <th className="px-2 py-2" /> : null}
                  </tr></thead>
                  <tbody>
                    {day.lines.map((l) => (
                      <tr key={l.productId} className={clsx('border-t border-line', l.manual && 'bg-warn-soft')}>
                        <td className="max-w-[260px] px-3 py-2"><div className="break-words font-semibold">{l.manual ? '✎ ' : ''}{l.name}</div><div className="break-words text-[12px] text-muted">{l.code} · {money(l.unitPrice)}{l.manualNote ? ` · ${l.manualNote}` : ''}</div></td>
                        <td className="px-2 py-2 text-right font-semibold text-ok-ink">{l.qty}</td><td className="px-2 py-2 text-right text-bad-ink">{l.cancelledQty}</td>
                        <td className="px-2 py-2 text-right font-semibold">{money(l.sales)}</td>
                        <td className="px-2 py-2 text-right">{money(l.operatorCost)}</td><td className="px-2 py-2 text-right">{money(l.deliveryCost)}</td><td className="px-2 py-2 text-right">{money(l.marketingCost)}</td>
                        <td className="px-2 py-2 text-right" title={l.otherNote}>{money(l.otherCost)}</td>
                        <td className={clsx('px-3 py-2 text-right font-bold', l.net < 0 ? 'text-bad-ink' : 'text-ok-ink')}>{money(l.net)}</td>
                        {detail.isSuperAdmin && !locked ? <td className="px-2 py-2 text-right"><Button size="sm" onClick={() => setOv(l)}>Засах</Button></td> : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-col gap-2 md:hidden">
                {day.lines.map((l) => (
                  <div key={l.productId} className={clsx('flex min-w-0 flex-col gap-1.5 rounded-2xl border border-line bg-surface p-3', l.manual && 'bg-warn-soft')}>
                    <div className="flex items-start justify-between gap-2"><div className="min-w-0"><b className="break-words">{l.manual ? '✎ ' : ''}{l.name}</b><div className="break-words text-[12px] text-muted">{l.code} · {l.qty} ш · цуцалсан {l.cancelledQty}</div></div><b className="shrink-0 text-ok-ink">{money(l.net)}</b></div>
                    <div className="grid grid-cols-2 gap-x-3 text-[12.5px] text-muted">
                      <span>Борлуулалт {money(l.sales)}</span><span>Опп {money(l.operatorCost)}</span><span>Хүргэлт {money(l.deliveryCost)}</span><span>Маркетинг {money(l.marketingCost)}</span><span>Бусад {money(l.otherCost)}</span>
                    </div>
                    {detail.isSuperAdmin && !locked ? <Button size="sm" onClick={() => setOv(l)}>Суутгал засах</Button> : null}
                  </div>
                ))}
              </div>
            </>
          )}
          {day.adjustments.length ? (
            <div className="flex flex-col gap-2">
              <b className="text-[14px]">{locked ? 'Энэ шилжүүлэгт тооцогдсон буцаалт / нэмэгдэл' : 'Дараагийн шилжүүлэгт тооцогдох буцаалт / нэмэгдэл'}</b>
              <AdjList list={day.adjustments} empty="" />
            </div>
          ) : null}
          {locked && day.laterChanges?.length ? (
            <div className="flex flex-col gap-2"><b className="text-[14px]">Шилжүүлсний дараа илэрсэн өөрчлөлт</b><AdjList list={day.laterChanges} empty="" /></div>
          ) : null}
          <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13.5px] sm:grid-cols-5">
              <div className="flex flex-col"><span className="text-muted">Хүргэсэн</span><b>{day.totals.qty} ш</b></div>
              <div className="flex flex-col"><span className="text-muted">Борлуулалт</span><b>{money(day.totals.sales)}</b></div>
              <div className="flex flex-col"><span className="text-muted">Суутгал</span><b>{day.totals.deductions ? `−${money(day.totals.deductions)}` : money(0)}</b></div>
              <div className="flex flex-col"><span className="text-muted">Буцаалт / нэмэгдэл</span><b className={day.adjTotal < 0 ? 'text-bad-ink' : ''}>{money(day.adjTotal)}</b></div>
              <div className="flex flex-col"><span className="font-semibold text-ink">Шилжүүлэх дүн</span><b className="text-[20px] text-accent">{money(day.payable)}</b></div>
            </div>
            {day.carry < 0 ? <Notice tone="warn">Хасалт шилжүүлэх дүнгээс их — {money(-day.carry)} нь дараагийн шилжүүлгээс хасагдана.</Notice> : null}
            {detail.admin ? (
              <div className="flex flex-wrap justify-end gap-2">
                {locked && detail.isSuperAdmin ? <Button size="sm" onClick={() => { if (confirm('Шилжүүлсэн тэмдгийг буцаах уу? (Зөвхөн хамгийн сүүлд шилжүүлсэн өдөр)')) void post({ action: 'undo-transfer', date }, 'Буцаалаа').then(() => load()); }}>Шилжүүлснийг буцаах</Button> : null}
                {!locked ? <Button variant="primary" disabled={day.unfinished > 0 || (day.lines.length === 0 && day.adjustments.length === 0)} onClick={() => { if (confirm(`${date}-ны ${money(day.payable)}-ийг нийлүүлэгчид шилжүүлсэн гэж тэмдэглэх үү? Үүний дараа энэ өдөр түгжигдэнэ.`)) void post({ action: 'transfer', date, version: day.version }, 'Шилжүүлсэн гэж тэмдэглэлээ').then(() => load()); }}>Шилжүүлсэн гэж тэмдэглэх</Button> : null}
              </div>
            ) : null}
          </div>
        </>
      ) : null}
      {ov && day ? <OverrideDialog line={ov} date={date} version={day.version} onClose={() => setOv(null)} post={post} onDone={async () => { setOv(null); await load(); }} /> : null}
    </div>
  );
}

function OverrideDialog({ line, date, version, onClose, post, onDone }: { line: Line; date: string; version: number; onClose: () => void; post: Post; onDone: () => void }) {
  const [v, setV] = useState({ operatorCost: String(line.operatorCost), deliveryCost: String(line.deliveryCost), marketingCost: String(line.marketingCost), otherCost: String(line.otherCost), note: line.manualNote });
  const f = (k: keyof typeof v, label: string) => (
    <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">{label}<input value={v[k]} inputMode="numeric" onChange={(e) => setV({ ...v, [k]: digits(e.target.value) })} className={clsx(inputCls, 'text-right')} /></label>
  );
  const save = async (clear = false) => { const r = await post({ action: 'override', date, productId: line.productId, version, clear, ...v }, clear ? 'Тохиргоогоор болголоо' : 'Суутгал засагдлаа'); if (r) onDone(); };
  return (
    <Modal open onClose={onClose} title={`Суутгал засах · ${line.name}`} subtitle={`${date} · ${line.qty} ширхэг · зөвхөн Супер админ, түүхэнд бичигдэнэ`}
      footer={<>{line.manual ? <Button onClick={() => void save(true)}>Тохиргоогоор болгох</Button> : null}<Button onClick={onClose}>Болих</Button><Button variant="primary" onClick={() => void save()}>Хадгалах</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {f('operatorCost', 'Опп зардал (нийт)')}{f('deliveryCost', 'Хүргэлт (нийт)')}{f('marketingCost', 'Маркетинг (нийт)')}{f('otherCost', 'Бусад (нийт)')}
        <label className="col-span-2 flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Шалтгаан<input data-autofocus value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} className={inputCls} /></label>
      </div>
    </Modal>
  );
}

function DaysList({ days, empty, onPick }: { days: RangeDay[]; empty: string; onPick: (d: string) => void }) {
  if (!days.length) return <p className="rounded-2xl border border-line bg-surface p-6 text-center text-[14px] text-muted">{empty}</p>;
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface">
      {days.map((x) => (
        <button key={x.date} type="button" onClick={() => onPick(x.date)} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-2.5 text-left text-[13.5px] last:border-b-0 hover:bg-surface2">
          <b className="w-[92px] shrink-0">{x.date}</b>
          <span className="text-muted">{x.qty} ш · {money(x.sales)} − {money(x.deductions)}</span>
          {x.adjustments ? <span className="text-bad-ink">{money(x.adjustments)}</span> : null}
          <span className="ml-auto flex items-center gap-2"><b>{money(x.status === 'TRANSFERRED' ? x.payable : x.net)}</b>{x.status === 'TRANSFERRED' ? <Badge tone="ok">Шилжүүлсэн</Badge> : x.unfinished ? <Badge tone="warn">Дуусаагүй {x.unfinished}</Badge> : <Badge tone="warn">Шилжүүлээгүй</Badge>}</span>
        </button>
      ))}
    </div>
  );
}

function RangeTab({ q, onPick }: { q: string; onPick: (d: string) => void }) {
  const t = ubToday();
  const [from, setFrom] = useState(`${t.slice(0, 7)}-01`);
  const [to, setTo] = useState(t);
  const [r, setR] = useState<{ days: RangeDay[]; totals: { qty: number; sales: number; deductions: number; net: number; transferred: number; notTransferred: number; daysWithData: number } } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { (async () => { try { setR(await api(`/api/supplier?${q}&from=${from}&to=${to}`)); setErr(null); } catch (e) { setErr(msg(e)); } })(); }, [q, from, to]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className={inputCls} aria-label="Эхлэх огноо" /><span className="text-muted">—</span>
        <input type="date" value={to} max={t} onChange={(e) => e.target.value && setTo(e.target.value)} className={inputCls} aria-label="Дуусах огноо" />
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {r ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Нийт борлуулалт" value={money(r.totals.sales)} /><Stat label="Нийт суутгал" value={money(r.totals.deductions)} />
            <Stat label="Цэвэр дүн" value={money(r.totals.net)} tone="ok" /><Stat label="Суутгалын хувь" value={r.totals.sales ? `${((r.totals.deductions / r.totals.sales) * 100).toFixed(1)}%` : '—'} />
            <Stat label="Шилжүүлсэн" value={money(r.totals.transferred)} /><Stat label="Шилжүүлээгүй" value={money(r.totals.notTransferred)} tone="accent" />
            <Stat label="Тоо хэмжээ" value={`${r.totals.qty} ш`} /><Stat label="Өдөр" value={String(r.totals.daysWithData)} />
          </div>
          <DaysList days={r.days} empty="Энэ хугацаанд борлуулалт алга" onPick={onPick} />
        </>
      ) : null}
    </div>
  );
}

function AdjList({ list, empty }: { list: Adj[]; empty: string }) {
  if (!list.length) return empty ? <p className="rounded-2xl border border-line bg-surface p-6 text-center text-[14px] text-muted">{empty}</p> : null;
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface">
      {list.map((a) => (
        <div key={a.id} className="flex min-w-0 flex-col gap-1 border-b border-line px-4 py-3 last:border-b-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={a.amount < 0 ? 'bad' : 'ok'}>{a.kindLabel}</Badge>
            {a.orderNumber ? <b className="text-[13.5px]">{a.orderNumber}</b> : null}
            {a.productName ? <span className="min-w-0 break-words text-[13.5px]">{a.productName} × {a.qty}</span> : null}
            <b className={clsx('ml-auto text-[15px]', a.amount < 0 ? 'text-bad-ink' : 'text-ok-ink')}>{a.amount > 0 ? '+' : ''}{money(a.amount)}</b>
          </div>
          <p className="min-w-0 break-words text-[13px] text-muted">{a.reason}</p>
          <span className="text-[12px] text-subtle">{ubDateTime(a.createdAt)} · {a.appliedDate ? `${a.appliedDate}-ны шилжүүлэгт тооцогдсон` : 'Дараагийн шилжүүлэгт тооцогдоно'}</span>
        </div>
      ))}
    </div>
  );
}

function ProductsTab({ d, post }: { d: Detail; post: Post }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ id: number; code: string; name: string; price: number; shop: { id: number; name: string } | null }[]>([]);
  const [from, setFrom] = useState(d.today);
  const [showOld, setShowOld] = useState(false);
  useEffect(() => {
    if (!q.trim()) { setRes([]); return; }
    const t = setTimeout(async () => { try { setRes(await api(`/api/supplier?search=${encodeURIComponent(q)}`)); } catch { setRes([]); } }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = d.products.filter((p) => showOld || p.active);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
        <b className="text-[14px]">Бараа нэмэх</b>
        <div className="flex flex-wrap gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Барааны нэр, код" className={clsx(inputCls, 'flex-1')} aria-label="Бараа хайх" />
          <label className="flex items-center gap-2 text-[12.5px] text-muted">Эхлэх өдөр<input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className={inputCls} /></label>
        </div>
        {res.map((p) => (
          <div key={p.id} className="flex min-w-0 flex-wrap items-center gap-2 border-t border-line pt-2">
            <div className="min-w-0 flex-1"><b className="break-words text-[13.5px]">{p.name}</b><div className="text-[12px] text-muted">{p.code} · {money(p.price)}</div></div>
            {p.shop ? <Badge tone={p.shop.id === d.shop.id ? 'ok' : 'warn'}>{p.shop.id === d.shop.id ? 'Энэ дэлгүүрт' : `«${p.shop.name}»-д оноогдсон`}</Badge>
              : <Button size="sm" variant="primary" onClick={() => void post({ action: 'assign', productId: p.id, fromDate: from }, `«${p.name}» нэмэгдлээ`).then((r) => { if (r) setQ(''); })}>Нэмэх</Button>}
          </div>
        ))}
        <p className="text-[12px] text-subtle">Нэг бараа зөвхөн нэг нийлүүлэгчид — өөр дэлгүүрт оноогдсон барааг эхлээд тэндээс хасна.</p>
        {d.defaults ? <p className="min-w-0 break-words text-[12px] text-subtle">Нэмэхэд автоматаар тавигдах суутгал: {dedText(d.defaults)}{d.isSuperAdmin ? ' — «Нийлүүлэгч» хуудасны «Анхдагч суутгал» товчоор өөрчилнө.' : ''}</p> : null}
      </div>
      <div className="flex items-center justify-between gap-2">
        <b className="text-[14px]">Хувиарласан бараа ба 1 ширхэгийн суутгал</b>
        <label className="flex items-center gap-1.5 text-[12.5px] text-muted"><input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} />Хасагдсаныг харуулах</label>
      </div>
      {list.length === 0 ? <p className="rounded-2xl border border-line bg-surface p-6 text-center text-[14px] text-muted">Бараа хувиарлагдаагүй</p> : null}
      {list.map((p) => <ProductRow key={p.id} p={p} shopId={d.shop.id} post={post} canEdit={d.isSuperAdmin} />)}
    </div>
  );
}

function ProductRow({ p, post, canEdit }: { p: Prod; shopId: number; post: Post; canEdit: boolean }) {
  const [v, setV] = useState({ operatorCost: String(p.deduction.operatorCost), deliveryCost: String(p.deduction.deliveryCost), marketingCost: String(p.deduction.marketingCost), otherCost: String(p.deduction.otherCost), otherNote: p.deduction.otherNote });
  const per = ['operatorCost', 'deliveryCost', 'marketingCost', 'otherCost'].reduce((a, k) => a + Number(v[k as keyof typeof v] || 0), 0);
  const f = (k: keyof typeof v, label: string) => (
    <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-muted">{label}<input value={v[k]} inputMode="numeric" disabled={!p.active || !canEdit} onChange={(e) => setV({ ...v, [k]: digits(e.target.value) })} className={clsx(inputCls, 'text-right')} /></label>
  );
  return (
    <div className={clsx('flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4', !p.active && 'opacity-70')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0"><b className="break-words">{p.name}</b><div className="break-words text-[12px] text-muted">{p.code} · {p.fromDate}-аас{p.toDate ? ` ${p.toDate} хүртэл (${p.endedByName ?? ''})` : ''} · {p.createdByName}</div></div>
        {p.active && !p.toDate ? <Button size="sm" onClick={() => { if (confirm(`«${p.name}»-ийг хасах уу? Өнөөдрийн падаан энэ дэлгүүрт тооцогдоно, маргаашаас хамаарахгүй.`)) void post({ action: 'unassign', id: p.id }, 'Хасагдлаа'); }}>Хасах</Button> : <Badge>{p.toDate ? `${p.toDate}-аас хасагдсан` : ''}</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {f('operatorCost', 'Опп зардал')}{f('deliveryCost', 'Хүргэлт')}{f('marketingCost', 'Маркетинг')}{f('otherCost', 'Бусад')}
        <label className="col-span-2 flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-muted sm:col-span-1">Бусдын тайлбар<input value={v.otherNote} disabled={!p.active || !canEdit} onChange={(e) => setV({ ...v, otherNote: e.target.value })} className={inputCls} /></label>
      </div>
      {p.active ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12.5px] text-muted">1 ширхэгээс нийт {money(per)} хасна (× авсан тоо)</span>
          {canEdit ? <Button size="sm" variant="primary" onClick={() => void post({ action: 'deduction', productId: p.productId, ...v }, 'Суутгал хадгалагдлаа')}>Хадгалах</Button> : <span className="text-[12px] text-subtle">Суутгалыг Супер админ өөрчилнө</span>}
        </div>
      ) : null}
    </div>
  );
}

function LoginTab({ d, post }: { d: Detail; post: Post }) {
  const [name, setName] = useState(d.shop.contactName || d.shop.name);
  const [phone, setPhone] = useState(d.shop.contactPhone.replace(/\D/g, '').slice(0, 8));
  const [temp, setTemp] = useState<{ phone: string; pass: string } | null>(null);
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      {temp ? <Notice tone="ok">Нэвтрэх: {temp.phone} · түр нууц үг: <b className="select-all font-mono">{temp.pass}</b> — нийлүүлэгчид өгнө үү (анх нэвтрэхдээ солино). Энэ нууц үг дахин харагдахгүй.</Notice> : null}
      {d.login ? (
        <>
          <div className="flex flex-col gap-0.5"><b className="break-words">{d.login.name}</b><span className="text-[13px] text-muted">Утас: {d.login.phone} · {d.login.isActive ? 'Идэвхтэй' : 'Хаагдсан'} · сүүлд нэвтэрсэн: {d.login.lastLoginAt ? ubDateTime(d.login.lastLoginAt) : '—'}</span></div>
          <p className="text-[13px] text-muted">Нийлүүлэгч зөвхөн өөрийн дэлгүүрийн тооцоо, буцаалтыг харна, юу ч өөрчлөхгүй.</p>
          <div><Button size="sm" onClick={() => void post({ action: 'login-reset' }).then((r) => { if (r) setTemp({ phone: d.login!.phone, pass: String(r.temporaryPassword) }); })}>Нууц үг сэргээх</Button></div>
        </>
      ) : (
        <>
          <b className="text-[14px]">Нэвтрэх эрх үүсгэх</b>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Нэр<input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></label>
            <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Утас (нэвтрэх нэр)<input value={phone} inputMode="numeric" onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 8))} className={inputCls} /></label>
          </div>
          <div><Button variant="primary" size="sm" onClick={() => void post({ action: 'login', name, phone }, 'Нэвтрэх эрх үүслээ').then((r) => { if (r) setTemp({ phone: String(r.phone), pass: String(r.temporaryPassword) }); })}>Үүсгэх</Button></div>
        </>
      )}
    </div>
  );
}
