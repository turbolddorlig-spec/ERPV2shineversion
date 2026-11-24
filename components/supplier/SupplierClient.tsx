'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Badge } from '@/components/ui/Badge';
import { SupplierNotices } from './SupplierNotices';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';
import { ReorderDialog } from '@/components/outflow/OutflowClient';

/**
 * Нийлүүлэгч (Модуль 7в, хуучин «Гадны дэлгүүр удирдлага»): самбар → дэлгүүр → өдрийн тооцоо (падааны өдрөөр),
 * нэгтгэл, шилжүүлсэн, бараа + суутгал, буцаалт/нэмэгдэл (шалтгаантай), нэвтрэх эрх. Нийлүүлэгч өөрөө зөвхөн өөрийнхийг харна.
 */
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const ubToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const digits = (s: string) => s.replace(/\D/g, '').slice(0, 9);
const inputCls = 'h-10 min-w-0 rounded-[10px] border border-line bg-surface px-2.5 text-[13.5px]';

interface OrderDay { label: string; date: string; total: number; delivered: number; cancelled: number; onRoad: number; pending: number; amount: number; shops?: { id: number; name: string; total: number; amount: number }[] }
interface Spark { date: string; v: number }
interface Transfer { at: string; byName: string | null; from: string; to: string; days: number; amount: number }
interface ShopRow { id: number; name: string; contactName: string; contactPhone: string; isActive: boolean; hasLogin: boolean; productCount: number; openDays: number; balance: number; pendingAdj: number; monthSales: number; spark?: Spark[]; lastTransfer?: Transfer | null }
interface Overview { stats: { activeShops: number; monthSales: number; monthNet: number; todaySales: number; todayNet: number; balance: number }; orderDays: OrderDay[]; shops: ShopRow[]; isSuperAdmin: boolean; defaults: Ded }
interface Ded { operatorCost: number; deliveryCost: number; marketingCost: number; otherCost: number; otherNote: string }
interface Prod { id: number; productId: number; code: string; name: string; fromDate: string; toDate: string | null; active: boolean; createdByName: string; endedByName: string | null; deduction: Ded }
interface Adj { id: number; kind: string; kindLabel: string; sourceDate: string | null; orderNumber: string | null; productName: string | null; qty: number; sales: number; deduction: number; amount: number; reason: string; createdAt: string; appliedDate: string | null }
interface RangeDay { date: string; status: string; qty: number; sales: number; deductions: number; net: number; adjustments: number; payable: number; unfinished: number }
interface Detail {
  shop: { id: number; name: string; contactName: string; contactPhone: string; isActive: boolean; version: number };
  admin: boolean; isSuperAdmin: boolean; today: string; products: Prod[]; defaults: Ded | null;
  balance: { openDays: number; openNet: number; pendingAdj: number; pendingAdjCount: number; balance: number };
  openDays: RangeDay[]; transferredDays: RangeDay[]; adjustments: Adj[]; orderDays: OrderDay[]; spark?: Spark[]; transfers?: Transfer[];
  login: { id: string; name: string; phone: string; isActive: boolean; lastLoginAt: string | null } | null;
}
interface Line { productId: number; code: string; name: string; qty: number; cancelledQty: number; unitPrice: number; sales: number; operatorCost: number; deliveryCost: number; marketingCost: number; otherCost: number; otherNote: string; deduction: number; net: number; manual: boolean; manualNote: string; manualPerUnit?: { operatorCost: number; deliveryCost: number; marketingCost: number; otherCost: number } | null }
interface Day { shopId: number; date: string; status: 'OPEN' | 'TRANSFERRED'; lines: Line[]; totals: { qty: number; cancelledQty: number; sales: number; deductions: number; net: number }; unfinished: number; adjustments: Adj[]; adjTotal: number; payable: number; carry: number; transferredAt: string | null; transferredByName: string | null; version: number; laterChanges?: Adj[] }

export function SupplierClient({ admin }: { admin: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!admin) return <ShopPanel shopId={null} />;
  if (open !== null) return <ShopPanel shopId={open} onBack={() => setOpen(null)} />;
  return <AdminOverview onOpen={setOpen} />;
}

function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: 'accent' | 'ok' | 'bad' | 'warn'; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-2xl border border-line bg-surface px-4 py-3" style={{ boxShadow: `inset 0 3px 0 ${tone === 'ok' ? 'var(--ok)' : tone === 'bad' ? 'var(--bad)' : tone === 'warn' ? 'var(--warn)' : 'var(--page)'}` }}>
      <span className="text-[12.5px] font-semibold text-muted">{label}</span>
      <b className={clsx('break-words text-[17px] font-extrabold tracking-tight sm:text-[22px]', tone === 'accent' && 'text-accent', tone === 'ok' && 'text-ok-ink', tone === 'bad' && 'text-bad-ink', tone === 'warn' && 'text-warn')}>{value}</b>
      {sub ? <span className="break-words text-[12px] text-subtle">{sub}</span> : null}
    </div>
  );
}

const md = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8)}`;
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

/** #175 C: 14 хоногийн борлуулалтын жижиг график (сүүлийнх = өнөөдөр, тод) */
function Sparkline({ data }: { data: Spark[] }) {
  const max = Math.max(1, ...data.map((d) => d.v));
  return (
    <div className="flex h-[34px] items-end gap-[3px]" aria-hidden>
      {data.map((d, i) => <i key={d.date} title={`${md(d.date)} · ${money(d.v)}`} className={clsx('flex-1 rounded-t-[3px]', i === data.length - 1 ? 'bg-[var(--page)]' : 'bg-[color-mix(in_srgb,var(--page)_50%,transparent)]')} style={{ height: `${Math.max(6, (d.v / max) * 100)}%` }} />)}
    </div>
  );
}

/** #175 C: «А − Б = В» томьёо (ойлгомжтой) */
function Term({ label, value, tone, big }: { label: string; value: string; tone?: 'bad' | 'res'; big?: boolean }) {
  return (
    <div className={clsx('min-w-0 rounded-xl px-3 py-2', tone === 'res' ? 'bg-[color-mix(in_srgb,var(--page)_14%,var(--surface))]' : 'bg-surface2')}>
      <span className="block text-[12px] font-semibold text-muted">{label}</span>
      <b className={clsx('block break-words font-extrabold tracking-tight', big ? 'text-[22px]' : 'text-[17px]', tone === 'bad' && 'text-bad-ink', tone === 'res' && 'text-[var(--page)]')}>{value}</b>
    </div>
  );
}
const Op = ({ c }: { c: string }) => <span aria-hidden className="text-[20px] font-extrabold text-subtle">{c}</span>;

/** #175 C: суутгалын 4 төрөл өнгөт зураасаар */
const DED_COLORS = ['#0EA5E9', '#F59E0B', '#A855F7', '#64748B'];
function DedStack({ parts }: { parts: [string, number][] }) {
  const total = parts.reduce((a, [, v]) => a + Math.max(0, v), 0);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-3 overflow-hidden rounded-full bg-line" aria-hidden>{total ? parts.map(([l, v], i) => <i key={l} style={{ width: `${(Math.max(0, v) / total) * 100}%`, background: DED_COLORS[i] }} />) : null}</div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted">{parts.map(([l, v], i) => <span key={l} className="whitespace-nowrap"><i className="mr-1 inline-block h-2.5 w-2.5 rounded-[3px] align-middle" style={{ background: DED_COLORS[i] }} />{l} {money(v)}</span>)}</div>
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
  const [filterSel, setFilter] = useState<'due' | 'all' | 'inactive' | null>(null);
  const [q, setQ] = useState('');
  const [showDays, setShowDays] = useState(false);
  const load = useCallback(async () => { try { setD(await api('/api/supplier')); setErr(null); } catch (e) { setErr(msg(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="flex flex-col gap-4">
      <div data-page-band className="page-band rounded-[16px] px-4 py-3.5 shadow-card md:px-5 md:py-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0"><h1 className="text-[24px] font-extrabold tracking-tight">Нийлүүлэгч</h1><p className="band-sub text-[13.5px]">Гадны дэлгүүрийн бараа · падааны өдрөөр тооцоо · борлуулалт − суутгал = шилжүүлэх дүн</p></div>
        <div className="band-actions flex flex-wrap gap-2">
          {d?.isSuperAdmin ? <Button size="sm" onClick={() => setDefs(true)}>⚙ Анхдагч суутгал</Button> : null}
          <Button variant="primary" size="sm" onClick={() => setAdd(true)}>+ Дэлгүүр нэмэх</Button>
        </div>
      </div>
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
      {err ? <Notice>{err}</Notice> : null}
      {/* #215: нийлүүлэгчид мэдэгдэл */}
      <SupplierNotices />
      {d ? (() => {
        const dueShops = d.shops.filter((x) => x.isActive && (x.balance !== 0 || x.openDays > 0));
        const filter = filterSel ?? (dueShops.length ? 'due' : 'all');
        const sq = q.trim().toLowerCase();
        const list = d.shops
          .filter((x) => (filter === 'all' || (filter === 'due' ? x.isActive && (x.balance !== 0 || x.openDays > 0) : !x.isActive)))
          .filter((x) => !sq || [x.name, x.contactName, x.contactPhone].some((t) => t.toLowerCase().includes(sq)))
          .sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.balance - a.balance || a.name.localeCompare(b.name, 'mn'));
        return (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Шилжүүлэх нийт үлдэгдэл" value={money(d.stats.balance)} tone="warn" sub={`${dueShops.length} дэлгүүр · ${dueShops.reduce((a, x) => a + x.openDays, 0)} өдөр`} />
              <Stat label="Өнөөдрийн борлуулалт" value={money(d.stats.todaySales)} sub={`цэвэр ${money(d.stats.todayNet)}`} />
              <Stat label="Энэ сарын борлуулалт" value={money(d.stats.monthSales)} sub={`цэвэр ${money(d.stats.monthNet)}`} />
              <Stat label="Идэвхтэй дэлгүүр" value={String(d.stats.activeShops)} sub={d.shops.length > d.stats.activeShops ? `${d.shops.length - d.stats.activeShops} идэвхгүй` : undefined} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {([['due', `Шилжүүлэх ёстой (${dueShops.length})`], ['all', `Бүгд (${d.shops.length})`], ['inactive', `Идэвхгүй (${d.shops.length - d.stats.activeShops})`]] as const).map(([k, l]) => (
                <button key={k} type="button" data-shop-filter={k} onClick={() => setFilter(k)} className={clsx('h-9 rounded-full border px-3.5 text-[13px] font-bold', filter === k ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-muted')}>{l}</button>
              ))}
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Дэлгүүр, хариуцагч, утас…" aria-label="Дэлгүүр хайх" className="h-9 min-w-[160px] flex-1 rounded-[10px] border border-line bg-surface px-3 text-[13.5px]" />
            </div>
            {d.shops.length === 0 ? <p className="rounded-2xl border border-line bg-surface p-6 text-center text-[14px] text-muted">Дэлгүүр бүртгэгдээгүй — «+ Дэлгүүр нэмэх»</p>
              : !list.length ? <p className="rounded-2xl border border-line bg-surface p-6 text-center text-[14px] text-muted">{filter === 'due' ? 'Шилжүүлэх дэлгүүр алга ✓' : 'Олдсонгүй'}</p> : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((x) => (
                <div key={x.id} data-shop-card={x.id} className={clsx('flex min-w-0 flex-col gap-2.5 rounded-[18px] border border-line bg-surface p-3.5 shadow-card', !x.isActive && 'opacity-70')}>
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--page)_16%,var(--surface))] text-[15px] font-extrabold text-[var(--page)]">{initials(x.name)}</span>
                    <div className="min-w-0 flex-1">
                      <b className="line-clamp-2 text-[15px] [overflow-wrap:anywhere]" title={x.name}>{x.name}</b>
                      <span className="line-clamp-2 text-[12.5px] text-subtle [overflow-wrap:anywhere]">{[x.contactName, x.contactPhone].filter(Boolean).join(' · ') || '—'} · {x.productCount} бараа</span>
                    </div>
                    {!x.isActive ? <Badge tone="bad">Идэвхгүй</Badge> : x.hasLogin ? <Badge tone="ok">● Нэвтэрдэг</Badge> : <Badge>Эрхгүй</Badge>}
                  </div>
                  <div className="flex min-w-0 items-baseline justify-between gap-2 rounded-xl bg-surface2 px-3 py-2.5">
                    <span className="text-[13px] font-bold text-muted">Шилжүүлэх</span>
                    {x.balance === 0 && x.openDays === 0 ? <b className="text-[14.5px] text-ok-ink">✓ Бүгд шилжсэн</b> : <b data-shop-due className={clsx('break-words text-[20px] font-extrabold tracking-tight', x.balance < 0 && 'text-bad-ink')}>{money(x.balance)}</b>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {x.openDays ? <Badge tone="warn">{x.openDays} өдөр шилжүүлээгүй</Badge> : null}
                    {x.pendingAdj ? <Badge tone={x.pendingAdj < 0 ? 'bad' : 'ok'}>{x.pendingAdj < 0 ? 'буцаалт' : 'нэмэгдэл'} {money(x.pendingAdj)}</Badge> : null}
                    {x.lastTransfer ? <Badge>Сүүлд {md(x.lastTransfer.to)} · {money(x.lastTransfer.amount)}</Badge> : null}
                  </div>
                  <div className="flex min-w-0 items-end gap-3">
                    <div className="min-w-0 flex-1"><span className="text-[11.5px] text-subtle">Сүүлийн 14 хоног · энэ сар {money(x.monthSales)}</span>{x.spark?.length ? <Sparkline data={x.spark} /> : <div className="h-[34px]" />}</div>
                    <Button size="sm" variant={x.balance ? 'primary' : 'secondary'} data-shop-open={x.id} onClick={() => onOpen(x.id)}>{x.balance ? 'Тооцоо →' : 'Нээх →'}</Button>
                  </div>
                </div>
              ))}
            </div>
            <section className="rounded-2xl border border-line bg-surface p-3">
              <button type="button" aria-expanded={showDays} onClick={() => setShowDays(!showDays)} className="w-full text-left text-[13.5px] font-bold">{showDays ? '▾' : '▸'} Захиалгын тоо (өдрөөр)</button>
              {showDays ? <div className="mt-2"><OrderDays days={d.orderDays} all /></div> : null}
            </section>
            <p className="min-w-0 break-words text-[12.5px] text-subtle">Бараа нэмэхэд автоматаар тавигдах суутгал (1 ширхэгээс): {dedText(d.defaults)}</p>
          </>
        );
      })() : null}
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

type Tab = 'outflow' | 'day' | 'range' | 'done' | 'products' | 'adj' | 'login';

function ShopPanel({ shopId, onBack }: { shopId: number | null; onBack?: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>(shopId === null ? 'outflow' : 'day');
  const [date, setDate] = useState(ubToday());
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [showDays, setShowDays] = useState(false);
  const q = shopId === null ? 'me=1' : `shop=${shopId}`;
  const load = useCallback(async () => { try { setD(await api(`/api/supplier?${q}`)); setErr(null); } catch (e) { setErr(msg(e)); } }, [q]);
  useEffect(() => { void load(); }, [load]);
  const post = async (json: Record<string, unknown>, m?: string) => {
    try { const r = await api<Record<string, unknown>>('/api/supplier', { method: 'POST', json: { shopId, ...json } }); if (m) setOk(m); setErr(null); await load(); return r; } catch (e) { setErr(msg(e)); setOk(null); return null; }
  };
  if (!d) return <div className="flex flex-col gap-3">{err ? <Notice>{err}</Notice> : <p className="text-muted">Ачаалж байна…</p>}</div>;
  const tabs: [Tab, string][] = [['outflow', d.admin ? 'Барааны гарц' : 'Миний барааны гарц'], ['day', 'Өдрийн тооцоо'], ['range', 'Нэгтгэл'], ['done', 'Шилжүүлсэн'], ...(d.admin ? [['products', `Бараа (${d.products.filter((p) => p.active).length})`] as [Tab, string]] : []),
    ['adj', `Буцаалт${d.balance.pendingAdjCount ? ` (${d.balance.pendingAdjCount})` : ''}`], ...(d.admin ? [['login', 'Нэвтрэх эрх'] as [Tab, string]] : [])];
  return (
    <div className="flex flex-col gap-4">
      <div data-page-band className="page-band rounded-[16px] px-4 py-3.5 shadow-card md:px-5 md:py-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          {onBack ? <button type="button" data-back onClick={onBack} className="band-sub self-start text-[13px] font-bold hover:underline">← Дэлгүүрүүд</button> : null}
          <h1 className="min-w-0 break-words text-[24px] font-extrabold tracking-tight">{d.shop.name}</h1>
          <p className="band-sub min-w-0 break-words text-[13.5px]">{[d.shop.contactName, d.shop.contactPhone].filter(Boolean).join(' · ') || (d.admin ? 'Холбогдох мэдээлэлгүй' : 'Тооцооны самбар')}{d.shop.isActive ? '' : ' · Идэвхгүй'}</p>
        </div>
        {d.admin ? (
          <div className="band-actions flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setEdit(true)}>Засах</Button>
            <Button size="sm" onClick={() => { if (confirm(d.shop.isActive ? 'Дэлгүүрийг идэвхгүй болгох уу? Нийлүүлэгч нэвтрэх боломжгүй болно.' : 'Идэвхжүүлэх үү?')) void post({ action: 'active', active: !d.shop.isActive }, 'Хадгаллаа'); }}>{d.shop.isActive ? 'Идэвхгүй болгох' : 'Идэвхжүүлэх'}</Button>
          </div>
        ) : null}
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
      {/* #175 C: «Одоо шилжүүлэх» томьёогоор + өнөөдөр + 7 хоног */}
      <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
        <section data-balance-card className="flex min-w-0 flex-col gap-2 rounded-[18px] border border-line bg-surface p-4 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <b className="text-[15px]">{d.admin ? 'Одоо шилжүүлэх' : 'Танд шилжүүлэх'}</b>
            {d.balance.openDays ? <Badge tone="warn">{d.balance.openDays} өдөр нээлттэй</Badge> : <Badge tone="ok">Бүгд шилжсэн</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Term label={`Нээлттэй ${d.balance.openDays} өдрийн цэвэр`} value={money(d.balance.openNet)} />
            <Op c={d.balance.pendingAdj < 0 ? '−' : '+'} />
            <Term label={`Буцаалт / нэмэгдэл${d.balance.pendingAdjCount ? ` (${d.balance.pendingAdjCount})` : ''}`} value={money(Math.abs(d.balance.pendingAdj))} tone={d.balance.pendingAdj < 0 ? 'bad' : undefined} />
            <Op c="=" />
            <Term label="Шилжүүлэх" value={money(d.balance.balance)} tone="res" big />
          </div>
          <span className="text-[12.5px] text-subtle">{d.transfers?.[0] ? `Сүүлд шилжүүлсэн: ${md(d.transfers[0].to)} · ${money(d.transfers[0].amount)}${d.transfers[0].byName ? ` · ${d.transfers[0].byName}` : ''}` : 'Шилжүүлэг хараахан алга'}</span>
        </section>
        <section className="flex min-w-0 flex-col gap-2 rounded-[18px] border border-line bg-surface p-4 shadow-card">
          {d.orderDays[0] ? (<>
            <b className="text-[15px]">{d.orderDays[0].label} ({md(d.orderDays[0].date)})</b>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-surface2 px-2 py-1.5"><b className="block text-[19px] text-ok-ink">{d.orderDays[0].delivered}</b><span className="text-[11.5px] text-subtle">хүргэсэн</span></div>
              <div className="rounded-xl bg-surface2 px-2 py-1.5"><b className="block text-[19px] text-info">{d.orderDays[0].onRoad}</b><span className="text-[11.5px] text-subtle">замд</span></div>
              <div className="rounded-xl bg-surface2 px-2 py-1.5"><b className="block text-[19px] text-bad-ink">{d.orderDays[0].cancelled}</b><span className="text-[11.5px] text-subtle">цуцалсан</span></div>
            </div>
          </>) : null}
          {d.spark?.length ? (
            <div data-week-bars className="flex flex-col gap-1">
              <span className="text-[12px] font-semibold text-muted">Сүүлийн 7 хоногийн цэвэр</span>
              <div className="flex h-[70px] items-end gap-1.5">
                {(() => { const mx = Math.max(1, ...d.spark!.map((x) => x.v)); return d.spark!.map((x, i) => (
                  <div key={x.date} className="flex h-full flex-1 flex-col items-center justify-end gap-0.5" title={`${md(x.date)} · ${money(x.v)}`}>
                    <i className={clsx('w-full rounded-t-md', i === d.spark!.length - 1 ? 'bg-[var(--page)]' : 'bg-[color-mix(in_srgb,var(--page)_50%,transparent)]')} style={{ height: `${Math.max(4, (Math.max(0, x.v) / mx) * 100)}%` }} />
                    <span className="text-[10px] text-subtle">{i === d.spark!.length - 1 ? 'Өнөөдөр' : md(x.date)}</span>
                  </div>
                )); })()}
              </div>
            </div>
          ) : null}
        </section>
      </div>
      <section className="rounded-2xl border border-line bg-surface p-3">
        <button type="button" aria-expanded={showDays} onClick={() => setShowDays(!showDays)} className="w-full text-left text-[13.5px] font-bold">{showDays ? '▾' : '▸'} Захиалгын тоо (өдрөөр)</button>
        {showDays ? <div className="mt-2"><OrderDays days={d.orderDays} /></div> : null}
      </section>
      <div className="flex gap-1 overflow-x-auto rounded-xl bg-surface2 p-1">
        {tabs.map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={clsx('shrink-0 rounded-lg px-3.5 py-2 text-[13.5px] font-semibold', tab === k ? 'bg-surface text-ink shadow-sm' : 'text-muted')}>{l}</button>
        ))}
      </div>
      {tab === 'outflow' ? <OutflowTab shopId={shopId} /> : null}
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
  const [flash, setFlash] = useState<string | null>(null);
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
            {day.lines.length ? (
              <div data-day-formula className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Term label={`Борлуулалт (${day.totals.qty}ш)`} value={money(day.totals.sales)} /><Op c="−" />
                  <Term label="Суутгал" value={money(day.totals.deductions)} tone="bad" /><Op c="=" />
                  <Term label="Цэвэр" value={money(day.totals.net)} tone="res" big />
                </div>
                <DedStack parts={[['Опп', day.lines.reduce((a, l) => a + l.operatorCost, 0)], ['Хүргэлт', day.lines.reduce((a, l) => a + l.deliveryCost, 0)], ['Маркетинг', day.lines.reduce((a, l) => a + l.marketingCost, 0)], ['Бусад', day.lines.reduce((a, l) => a + l.otherCost, 0)]]} />
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13.5px] sm:grid-cols-5">
              <div className="flex flex-col"><span className="text-muted">Хүргэсэн</span><b>{day.totals.qty} ш</b></div>
              <div className="flex flex-col"><span className="text-muted">Борлуулалт</span><b>{money(day.totals.sales)}</b></div>
              <div className="flex flex-col"><span className="text-muted">Суутгал</span><b>{day.totals.deductions ? `−${money(day.totals.deductions)}` : money(0)}</b></div>
              <div className="flex flex-col"><span className="text-muted">Буцаалт / нэмэгдэл</span><b className={day.adjTotal < 0 ? 'text-bad-ink' : ''}>{money(day.adjTotal)}</b></div>
              <div className="flex flex-col"><span className="font-semibold text-ink">Шилжүүлэх дүн</span><b className="text-[20px] text-accent">{money(day.payable)}</b></div>
            </div>
            {day.carry < 0 ? <Notice tone="warn">Хасалт шилжүүлэх дүнгээс их — {money(-day.carry)} нь дараагийн шилжүүлгээс хасагдана.</Notice> : null}
            {/* Аудит #151 (эзний шийдвэр): өмнөх өртэй (хасах) өдрүүд энэ шилжүүлгээс автоматаар хасагдана — тайлбартай */}
            {(() => {
              const neg = !locked ? detail.openDays.filter((o) => o.date < date && o.net < 0 && o.unfinished === 0) : [];
              if (!neg.length) return null;
              const sum = neg.reduce((a, o) => a + o.net, 0);
              return <Notice tone="warn">Өмнөх өртэй өдөр автоматаар хасагдана: {neg.map((o) => `${o.date} (${money(o.net)})`).join(', ')}. Шилжүүлэх дүн ойролцоогоор {money(Math.max(0, day.payable + sum))} болно (тус бүрийн тайлбар «Буцаалт» табд).</Notice>;
            })()}
            {flash ? <Notice tone="ok">{flash}</Notice> : null}
            {detail.admin ? (
              <div className="flex flex-wrap justify-end gap-2">
                {locked && detail.isSuperAdmin ? <Button size="sm" onClick={() => { if (confirm('Шилжүүлсэн тэмдгийг буцаах уу? (Зөвхөн хамгийн сүүлд шилжүүлсэн өдөр)')) void post({ action: 'undo-transfer', date }, 'Буцаалаа').then(() => load()); }}>Шилжүүлснийг буцаах</Button> : null}
                {!locked ? <Button variant="primary" disabled={day.unfinished > 0 || (day.lines.length === 0 && day.adjustments.length === 0)} onClick={() => { if (confirm(`${date}-ны ${money(day.payable)}-ийг нийлүүлэгчид шилжүүлсэн гэж тэмдэглэх үү? Үүний дараа энэ өдөр түгжигдэнэ.`)) void post({ action: 'transfer', date, version: day.version }).then((r) => { const nt = (r?.netted as { date: string; amount: number }[] | undefined) ?? []; setFlash(nt.length ? `Шилжүүлсэн гэж тэмдэглэлээ. Өмнөх өртэй өдөр автоматаар хасагдав: ${nt.map((x) => `${x.date} ${money(x.amount)}`).join(', ')}` : r ? 'Шилжүүлсэн гэж тэмдэглэлээ' : null); return load(); }); }}>Шилжүүлсэн гэж тэмдэглэх</Button> : null}
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
  // Б19: 1 ширхэгийн суутгалаар засна (хүргэгдсэн тоогоор үржинэ)
  const per = (total: number) => String(line.qty > 0 ? Math.round(total / line.qty) : total);
  const pu = line.manualPerUnit;
  const [v, setV] = useState({ operatorCost: pu ? String(pu.operatorCost) : per(line.operatorCost), deliveryCost: pu ? String(pu.deliveryCost) : per(line.deliveryCost), marketingCost: pu ? String(pu.marketingCost) : per(line.marketingCost), otherCost: pu ? String(pu.otherCost) : per(line.otherCost), note: line.manualNote });
  const f = (k: keyof typeof v, label: string) => (
    <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">{label}<input value={v[k]} inputMode="numeric" onChange={(e) => setV({ ...v, [k]: digits(e.target.value) })} className={clsx(inputCls, 'text-right')} /></label>
  );
  const save = async (clear = false) => { const r = await post({ action: 'override', date, productId: line.productId, version, clear, ...v }, clear ? 'Тохиргоогоор болголоо' : 'Суутгал засагдлаа'); if (r) onDone(); };
  return (
    <Modal open onClose={onClose} title={`Суутгал засах · ${line.name}`} subtitle={`${date} · ${line.qty} ширхэг · зөвхөн Супер админ, түүхэнд бичигдэнэ`}
      footer={<>{line.manual ? <Button onClick={() => void save(true)}>Тохиргоогоор болгох</Button> : null}<Button onClick={onClose}>Болих</Button><Button variant="primary" onClick={() => void save()}>Хадгалах</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {f('operatorCost', 'Опп зардал (1 ширхэг)')}{f('deliveryCost', 'Хүргэлт (1 ширхэг)')}{f('marketingCost', 'Маркетинг (1 ширхэг)')}{f('otherCost', 'Бусад (1 ширхэг)')}
        <p className="col-span-2 text-[12px] text-muted">Хүргэгдсэн ширхэгээр үржинэ — одоо {line.qty} ширхэг; хожим нэмэгдвэл суутгал ч өснө.</p>
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
  const [reason, setReason] = useState('');
  const [showOld, setShowOld] = useState(false);
  // #204: оноосон барааны эхлэх огноог өөрчлөх (Супер админ)
  const [fd, setFd] = useState(d.today);
  const [fr, setFr] = useState('');
  const changeFrom = (body: { ids?: number[]; all?: boolean }, label: string) => {
    if (fr.trim().length < 5) { alert('Шалтгаанаа бичнэ үү (5+ тэмдэгт)'); return; }
    if (!confirm(`${label} эхлэх огноог ${fd} болгох уу? ${fd} өдрөөс хойшхи борлуулалт нийлүүлэгчийн тооцоонд орно.`)) return;
    void post({ action: 'fromDate', shopId: d.shop.id, fromDate: fd, reason: fr, ...body }, 'Эхлэх огноо өөрчлөгдлөө');
  };
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
        {/* Аудит #151: хуучин огноогоор (90 хоног хүртэл) — тэр өдрөөс хойшхи борлуулалтыг нөхөж олгоно, шалтгаан заавал */}
        {from < d.today ? <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Хуучин огноогоор оноох шалтгаан (тэр өдрөөс хойшхи борлуулалтыг нийлүүлэгчид нөхөж олгоно)" aria-label="Шалтгаан" className={inputCls} /> : null}
        {res.map((p) => (
          <div key={p.id} className="flex min-w-0 flex-wrap items-center gap-2 border-t border-line pt-2">
            <div className="min-w-0 flex-1"><b className="break-words text-[13.5px]">{p.name}</b><div className="text-[12px] text-muted">{p.code} · {money(p.price)}</div></div>
            {p.shop ? <Badge tone={p.shop.id === d.shop.id ? 'ok' : 'warn'}>{p.shop.id === d.shop.id ? 'Энэ дэлгүүрт' : `«${p.shop.name}»-д оноогдсон`}</Badge>
              : <Button size="sm" variant="primary" onClick={() => void post({ action: 'assign', productId: p.id, fromDate: from, reason }, `«${p.name}» нэмэгдлээ`).then((r) => { if (r) setQ(''); })}>Нэмэх</Button>}
          </div>
        ))}
        <p className="text-[12px] text-subtle">Нэг бараа зөвхөн нэг нийлүүлэгчид — өөр дэлгүүрт оноогдсон барааг эхлээд тэндээс хасна.</p>
        {d.defaults ? <p className="min-w-0 break-words text-[12px] text-subtle">Нэмэхэд автоматаар тавигдах суутгал: {dedText(d.defaults)}{d.isSuperAdmin ? ' — «Нийлүүлэгч» хуудасны «Анхдагч суутгал» товчоор өөрчилнө.' : ''}</p> : null}
      </div>
      {d.isSuperAdmin && list.some((p) => p.active && !p.toDate) ? (
        <div data-from-date className="flex min-w-0 flex-col gap-2 rounded-2xl border border-warn/40 bg-warn-soft/40 p-3">
          <b className="text-[13.5px]">Эхлэх огноо өөрчлөх</b>
          <p className="text-[12px] text-muted">Хожуу нэмсэн бараанд өмнөх өдрүүдийн борлуулалтыг тооцуулах (хамгийн ихдээ 90 хоног). Тэр өдрүүдийг аль хэдийн өөр замаар төлөөгүй эсэхийг шалгаарай.</p>
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" value={fd} max={d.today} onChange={(e) => e.target.value && setFd(e.target.value)} className={inputCls} aria-label="Шинэ эхлэх огноо" />
            <input value={fr} onChange={(e) => setFr(e.target.value)} maxLength={300} placeholder="Шалтгаан (жишээ: 11/19-өөс хойш энэ нийлүүлэгчийн бараа)" className={clsx(inputCls, 'min-w-0 flex-1')} aria-label="Шалтгаан" />
            <Button size="sm" variant="primary" onClick={() => changeFrom({ all: true }, 'Энэ дэлгүүрийн БҮХ идэвхтэй барааны')}>Бүх барааг энэ өдрөөс</Button>
          </div>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <b className="text-[14px]">Хувиарласан бараа ба 1 ширхэгийн суутгал</b>
        <label className="flex items-center gap-1.5 text-[12.5px] text-muted"><input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} />Хасагдсаныг харуулах</label>
      </div>
      {list.length === 0 ? <p className="rounded-2xl border border-line bg-surface p-6 text-center text-[14px] text-muted">Бараа хувиарлагдаагүй</p> : null}
      {list.map((p) => <ProductRow key={p.id} p={p} shopId={d.shop.id} post={post} canEdit={d.isSuperAdmin} onFrom={d.isSuperAdmin && p.active && !p.toDate && p.fromDate !== fd ? () => changeFrom({ ids: [p.id] }, `«${p.name}»-ийн`) : undefined} fromLabel={fd} />)}
    </div>
  );
}

function ProductRow({ p, post, canEdit, onFrom, fromLabel }: { p: Prod; shopId: number; post: Post; canEdit: boolean; onFrom?: () => void; fromLabel?: string }) {
  const [v, setV] = useState({ operatorCost: String(p.deduction.operatorCost), deliveryCost: String(p.deduction.deliveryCost), marketingCost: String(p.deduction.marketingCost), otherCost: String(p.deduction.otherCost), otherNote: p.deduction.otherNote });
  const per = ['operatorCost', 'deliveryCost', 'marketingCost', 'otherCost'].reduce((a, k) => a + Number(v[k as keyof typeof v] || 0), 0);
  const f = (k: keyof typeof v, label: string) => (
    <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-muted">{label}<input value={v[k]} inputMode="numeric" disabled={!p.active || !canEdit} onChange={(e) => setV({ ...v, [k]: digits(e.target.value) })} className={clsx(inputCls, 'text-right')} /></label>
  );
  return (
    <div className={clsx('flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4', !p.active && 'opacity-70')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0"><b className="break-words">{p.name}</b><div className="break-words text-[12px] text-muted">{p.code} · {p.fromDate}-аас{p.toDate ? ` ${p.toDate} хүртэл (${p.endedByName ?? ''})` : ''} · {p.createdByName}</div></div>
        {onFrom ? <Button size="sm" onClick={onFrom}>Эхлэх огноо → {fromLabel}</Button> : null}
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

// ───────────── #122 Миний барааны гарц ─────────────
type RL = 'OK' | 'ORDER' | 'URGENT' | 'ORDERED' | 'LATE';
interface SupRow {
  id: number; code: string; name: string; price: number; daily: number[]; week: number; avg: number; available: number;
  reorder: { level: RL; days: number | null; pace: number; runOutDay: string | null; order: { expectedDay: string; qty: number } | null } | null;
  money: { perUnitDed: number; perUnitEarn: number; revenue: number; earn: number; cost: number | null; profit: number | null; perUnitProfit: number | null };
}
interface SupOutflow { shopId: number; days: string[]; rows: SupRow[]; isOwner: boolean; leadDays: number; urgentDays: number; needs: number }
const mdS = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
const RLV: Record<RL, { cls: string; label: string }> = {
  OK: { cls: 'text-muted hover:bg-surface2', label: 'хангалттай' }, ORDER: { cls: 'bg-warn-soft text-warn', label: '🟠 татах' },
  URGENT: { cls: 'animate-pulse bg-bad text-white', label: '🔴 яаралтай' }, ORDERED: { cls: 'bg-surface2 text-info', label: '🚚 захиалсан' }, LATE: { cls: 'bg-bad-soft text-bad-ink', label: '⏰ хоцорсон' },
};
function CoverChip({ r, onOpen }: { r: SupRow; onOpen: () => void }) {
  const x = r.reorder;
  if (!x) return <span className="text-[12px] text-subtle" title="Сүүлийн 7 хоногт зарагдаагүй">—</span>;
  const t = RLV[x.level];
  return (
    <button type="button" data-sup-cover={x.level} onClick={onOpen} className={clsx('inline-flex w-[80px] flex-col items-center rounded-lg px-1 py-0.5 leading-tight', t.cls)}>
      <b className="text-[13px]">{x.days === null ? '—' : `${x.days} хоног`}</b>
      <span className="text-[10.5px]">{x.order && x.level !== 'LATE' ? `🚚 ${mdS(x.order.expectedDay)}` : t.label}</span>
    </button>
  );
}
function CostInput({ r, onSave }: { r: SupRow; onSave: (v: string) => void }) {
  const init = r.money.cost === null ? '' : String(r.money.cost);
  const [v, setV] = useState(init);
  useEffect(() => setV(init), [init]);
  return <input value={v} inputMode="numeric" placeholder="өртөг" aria-label={`${r.name} өөрийн өртөг`} onChange={(e) => setV(digits(e.target.value))} onBlur={() => { if (v !== init) onSave(v); }} className={clsx(inputCls, 'h-8 w-[92px] text-right')} />;
}
function OutflowTab({ shopId }: { shopId: number | null }) {
  const [d, setD] = useState<SupOutflow | null>(null); const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const [dlg, setDlg] = useState<SupRow | null>(null);
  const q = shopId === null ? '' : `?shop=${shopId}`;
  const load = useCallback(async () => { try { setD(await api<SupOutflow>(`/api/supplier/outflow${q}`)); setErr(null); } catch (e) { setErr(msg(e)); } }, [q]);
  useEffect(() => { void load(); }, [load]);
  const post = async (json: Record<string, unknown>, m?: string) => {
    try { const r = await api<Record<string, unknown>>('/api/supplier/outflow', { method: 'POST', json: { shopId, ...json } }); if (m) setOk(m); setErr(null); await load(); return r; } catch (e) { setErr(msg(e)); setOk(null); return null; }
  };
  if (!d) return err ? <Notice>{err}</Notice> : <p className="text-muted">Ачаалж байна…</p>;
  const tot = d.rows.reduce((a, r) => ({ week: a.week + r.week, earn: a.earn + r.money.earn, profit: a.profit + (r.money.profit ?? 0) }), { week: 0, earn: 0, profit: 0 });
  const hasCost = d.rows.some((r) => r.money.cost !== null);
  return (
    <div className="flex flex-col gap-3">
      {err ? <Notice>{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
      {d.needs ? <p role="alert" className="rounded-[14px] border border-warn/40 bg-warn-soft px-4 py-3 text-[13.5px] font-semibold text-warn">🚚 Бараа их гарч байна, дуусах дөхлөө — {d.needs} бараагаа татаарай (Хятадаас ~{d.leadDays} хоногт ирнэ). «Нөөц» дээр дарж «Захиалсан» гэж тэмдэглэнэ.</p> : null}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-2xl border border-line bg-surface p-3"><div className="text-[12.5px] text-muted">7 хоногт зарагдсан</div><b className="text-[20px]">{tot.week} ш</b></div>
        <div className="rounded-2xl border border-line bg-surface p-3"><div className="text-[12.5px] text-muted">7 хоногт авах мөнгө (тооцоолол)</div><b className="text-[20px] text-accent">{money(tot.earn)}</b></div>
        {d.isOwner && hasCost ? <div className="rounded-2xl border border-line bg-surface p-3"><div className="text-[12.5px] text-muted">7 хоногийн цэвэр ашиг</div><b className={clsx('text-[20px]', tot.profit < 0 ? 'text-bad-ink' : 'text-ok-ink')}>{money(tot.profit)}</b></div> : null}
      </div>
      {d.rows.length === 0 ? <p className="rounded-2xl border border-line bg-surface p-6 text-center text-muted">Танд оноогдсон бараа алга</p> : (<>
        <div className="hidden overflow-x-auto rounded-2xl border border-line bg-surface lg:block">
          <table className="w-full text-[13px]">
            <thead><tr className="bg-surface2 text-[12px] text-muted">
              <th className="px-2 py-2 text-left">Бараа</th>
              {d.days.map((x, i) => <th key={x} className="px-1 py-2 text-center">{i === 0 ? 'Өнөөдөр' : mdS(x)}</th>)}
              <th className="px-2 py-2 text-center">7 хоног</th><th className="px-2 py-2 text-right">Боломжтой</th><th className="px-2 py-2 text-center">Нөөц</th>
              <th className="px-2 py-2 text-right">1 ш-д авах</th><th className="px-2 py-2 text-right">7 хоногт авах</th>
              {d.isOwner ? <><th className="px-2 py-2 text-right">Өөрийн өртөг</th><th className="px-2 py-2 text-right">Цэвэр ашиг</th></> : null}
            </tr></thead>
            <tbody>{d.rows.map((r) => (
              <tr key={r.id} data-sup-row className="border-t border-line">
                <td className="w-[200px] min-w-[200px] max-w-[200px] px-2 py-1.5"><div title={r.name} className="line-clamp-2 [overflow-wrap:anywhere] font-semibold">{r.name}</div><div className="text-[11.5px] text-muted">{r.code} · {money(r.price)}</div></td>
                {r.daily.map((n, i) => <td key={i} className="px-1 py-1 text-center"><div className={clsx('mx-auto w-9 rounded-md py-0.5', n ? 'bg-ok-soft font-semibold text-ok-ink' : 'text-subtle')}>{n}</div></td>)}
                <td className="px-2 py-1 text-center font-bold">{r.week}<div className="text-[10.5px] font-normal text-muted">⌀{r.avg}</div></td>
                <td className="px-2 py-1 text-right">{r.available}</td>
                <td className="px-1 py-1 text-center"><CoverChip r={r} onOpen={() => setDlg(r)} /></td>
                <td className="px-2 py-1 text-right" title={`Үнэ ${money(r.price)} − суутгал ${money(r.money.perUnitDed)}`}>{money(r.money.perUnitEarn)}</td>
                <td className="px-2 py-1 text-right font-semibold">{money(r.money.earn)}</td>
                {d.isOwner ? <><td className="px-2 py-1 text-right"><CostInput r={r} onSave={(v) => void post({ action: 'cost', productId: r.id, cost: v }, 'Өртөг хадгалагдлаа')} /></td>
                  <td className={clsx('px-2 py-1 text-right font-semibold', (r.money.profit ?? 0) < 0 && 'text-bad-ink')}>{r.money.profit === null ? '—' : <>{money(r.money.profit)}<div className="text-[10.5px] font-normal text-muted">1 ш {money(r.money.perUnitProfit ?? 0)}</div></>}</td></> : null}
              </tr>))}</tbody>
          </table>
        </div>
        <div className="flex flex-col gap-2 lg:hidden">
          {d.rows.map((r) => (
            <div key={r.id} className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line bg-surface p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><b className="[overflow-wrap:anywhere]">{r.name}</b><div className="text-[12px] text-muted">{r.code} · {money(r.price)} · боломжтой {r.available}</div></div>
                <CoverChip r={r} onOpen={() => setDlg(r)} />
              </div>
              <div className="grid grid-cols-7 gap-1 text-center text-[12px]">{r.daily.map((n, i) => <div key={i} className={clsx('rounded-md py-1', n ? 'bg-ok-soft font-semibold text-ok-ink' : 'bg-surface2 text-subtle')}><div className="text-[10px] font-normal text-muted">{i === 0 ? 'Өнөө' : mdS(d.days[i]!)}</div>{n}</div>)}</div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
                <span>7 хоног <b>{r.week} ш</b></span><span>1 ш-д авах <b>{money(r.money.perUnitEarn)}</b></span><span>7 хоногт <b className="text-accent">{money(r.money.earn)}</b></span>
                {d.isOwner ? <span className="flex items-center gap-1">Өртөг <CostInput r={r} onSave={(v) => void post({ action: 'cost', productId: r.id, cost: v }, 'Өртөг хадгалагдлаа')} /></span> : null}
                {d.isOwner && r.money.profit !== null ? <span>Цэвэр ашиг <b className={clsx((r.money.profit ?? 0) < 0 ? 'text-bad-ink' : 'text-ok-ink')}>{money(r.money.profit)}</b></span> : null}
              </div>
            </div>))}
        </div>
      </>)}
      <p className="text-[12px] text-muted [overflow-wrap:anywhere]">Гарц = тухайн өдөр баталгаажсан захиалгын ширхэг (төлбөр хүлээж буй, тэр өдөртөө цуцлагдсан орохгүй). «Авах мөнгө» = борлуулалт − 1 ширхэгийн суутгал × ширхэг — захиалгаар тооцоолсон; бодит шилжүүлэг нь хүргэгдсэн бараагаар «Өдрийн тооцоо»-нд. Нөөц = боломжтой ÷ өдрийн хурд; {d.leadDays} хоногоос бага бол 🟠, {d.urgentDays}-оос бага бол 🔴. {d.isOwner ? 'Өөрийн өртгийг зөвхөн та харна.' : ''}</p>
      {dlg ? <ReorderDialog row={dlg} sub="нөөц ба захиалга" detailUrl={`/api/supplier/outflow?view=reorder&id=${dlg.id}${shopId === null ? '' : `&shop=${shopId}`}`} onClose={() => setDlg(null)} post={post} /> : null}
    </div>
  );
}
