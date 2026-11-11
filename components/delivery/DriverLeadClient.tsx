'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';
import { OperatorNote, StatusChip, type OItem } from '@/components/orders/OrdersClient';
import { PerformanceTab, ChartTab } from '@/components/delivery/LeadStats';
import { money, ubDateTime } from '@/lib/format';
import { RURAL, UB_DISTRICTS } from '@/lib/geo';

interface LItem extends OItem { driverId: string | null; driverName: string | null; handover: { id: number; number: string; status: string } | null; district: string | null; province: string }
interface Resp { page: number; pageSize: number; hasMore: boolean; canAssign: boolean; kpi: Record<string, number>; items: LItem[] }
interface Driver { id: string; name: string; phone: string; load: number }

const ubToday = (add = 0) => new Date(Date.now() + 8 * 3600_000 + add * 86_400_000).toISOString().slice(0, 10);
const md = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}`;
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const fsel = 'h-9 rounded-lg border border-line bg-surface2/60 px-2.5 text-[13px] text-ink outline-none focus:border-accent';
const th = 'px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted';
const loadTone = (n: number) => (n >= 20 ? 'bg-bad-soft text-bad-ink' : n >= 10 ? 'bg-warn-soft text-warn' : n > 0 ? 'bg-ok-soft text-ok-ink' : 'bg-surface2 text-subtle');

interface F { q: string; assign: string; deliveryDate: string; created: string; district: string; rural: boolean; status: string; driverId: string; pageSize: number }
const EMPTY: F = { q: '', assign: 'unassigned', deliveryDate: '', created: '', district: '', rural: false, status: '', driverId: '', pageSize: 50 };

/**
 * «Ахлах жолооч» — хуучин ERP-ийн бүтэц: KPI, шүүлтүүр (Хайх / Цэвэрлэх), олноор хуваарилах мөр, дүүргээр бүлэглэх,
 * мөр бүрт жолооч сонгох (ачааллын тэмдэгтэй), огноо солих. «Жолоочдын захиалга» — баруун талын самбар.
 */
function AssignView() {
  const [draft, setDraft] = useState<F>(EMPTY);
  const [f, setF] = useState<F>(EMPTY);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Resp | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [bulkDriver, setBulkDriver] = useState('');
  const [bulkDate, setBulkDate] = useState(ubToday(1));
  const [busy, setBusy] = useState(false);
  const [grouped, setGrouped] = useState(false);
  const [byDayOpen, setByDayOpen] = useState(false);
  const req = useRef(0);

  const load = useCallback(() => {
    const id = ++req.current;
    const sp = new URLSearchParams({ page: String(page), pageSize: String(f.pageSize), assign: f.assign });
    for (const k of ['q', 'deliveryDate', 'created', 'district', 'status', 'driverId'] as const) if (f[k]) sp.set(k, String(f[k]));
    if (f.rural) sp.set('rural', '1');
    return api<Resp>(`/api/driver-lead/orders?${sp}`).then((r) => { if (id === req.current) { setData(r); setError(null); } }).catch((e) => setError(msg(e)));
  }, [f, page]);
  const loadDrivers = useCallback(() => api<{ items: Driver[] }>(`/api/driver-lead/drivers?date=${ubToday(1)}`).then((r) => setDrivers(r.items)).catch(() => undefined), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadDrivers(); }, [loadDrivers]);

  async function assign(ids: number[], driverId: string) {
    setBusy(true); setError(null);
    try {
      const r = await api<{ assigned: { number: string; date: string; movedNextDay: boolean }[]; skipped: { number: string; reason: string }[] }>('/api/driver-lead/assign', { method: 'POST', json: { ids, driverId } });
      const moved = r.assigned.filter((x) => x.movedNextDay).length;
      setFlash(`${r.assigned.length} захиалга хуваарилагдлаа${moved ? ` (${moved} нь падаан өгөгдсөн тул маргааш)` : ''}${r.skipped.length ? ` · алгассан ${r.skipped.length}: ${r.skipped.slice(0, 3).map((s) => `№${s.number} — ${s.reason}`).join('; ')}` : ''}`);
      setSel(new Set()); await Promise.all([load(), loadDrivers()]);
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  async function setDate(ids: number[], date: string) {
    setBusy(true); setError(null);
    try {
      const r = await api<{ updated: number; skipped: { number: string; reason: string }[] }>('/api/driver-lead/assign', { method: 'POST', json: { ids, date } });
      setFlash(`${r.updated} захиалгын огноо ${md(date)} боллоо${r.skipped.length ? ` · алгассан: ${r.skipped.slice(0, 3).map((s) => `№${s.number} — ${s.reason}`).join('; ')}` : ''}`);
      setSel(new Set()); await Promise.all([load(), loadDrivers()]);
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }

  const items = data?.items ?? [];
  const canAssign = !!data?.canAssign;
  const editable = (o: LItem) => canAssign && (o.status === 'NEW' || o.status === 'ASSIGNED') && o.handover?.status !== 'HANDED_OVER' && o.handover?.status !== 'RECEIVED';
  const groups = useMemo(() => {
    if (!grouped) return [{ key: '', items }];
    const m = new Map<string, LItem[]>();
    for (const o of items) { const k = o.province !== 'Улаанбаатар' ? 'Орон нутаг' : o.district ?? 'Бусад'; m.set(k, [...(m.get(k) ?? []), o]); }
    return [...m.entries()].sort(([a], [b]) => (a === 'Бусад' ? 1 : b === 'Бусад' ? -1 : a.localeCompare(b, 'mn'))).map(([key, its]) => ({ key, items: its }));
  }, [grouped, items]);
  const kpi = data?.kpi ?? {};
  const chipDays = [-2, -1, 0, 1, 2].map((o) => ubToday(o));

  return (
    <div className="full-bleed flex flex-col gap-3 text-[13px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-[24px] font-extrabold tracking-tight">Ахлах жолооч</h1>
          <p className="text-[12.5px] text-muted">Жолооч хуваарилалт болон гүйцэтгэл</p>
        </div>
        <button type="button" onClick={() => setByDayOpen(true)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-semibold hover:bg-surface2"><Icon name="box" size={15} />Жолоочдын захиалга</button>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
        {([['unassigned', 'Хуваарилаагүй', 'text-warn'], ['assignedToday', 'Өнөөдөр оноосон', 'text-info'], ['assignedTomorrow', 'Маргааш оноосон', 'text-info'], ['outForDelivery', 'Хүргэлтэд гарсан', 'text-accent-ink'], ['deliveredToday', 'Өнөөдөр хүргэсэн', 'text-ok-ink'], ['postponedToday', 'Өнөөдөр «Маргааш»', 'text-warn'], ['issues', 'Асуудалтай', 'text-bad-ink']] as const).map(([k, l, c]) => (
          <div key={k} className="rounded-xl border border-line bg-surface px-3 py-2.5"><p className="text-[11.5px] text-muted">{l}</p><p className={clsx('text-[22px] font-extrabold', c)}>{kpi[k] ?? '…'}</p></div>
        ))}
      </div>

      {kpi.leftover ? <p role="alert" data-lead-leftover className="rounded-xl border border-bad/40 bg-bad-soft px-4 py-2.5 text-[13.5px] font-semibold text-bad-ink">🔴 Хоносон, хуваарилагдаагүй {kpi.leftover} захиалга байна — яаралтай хуваарилна уу (хүргэх өдөр нь өнгөрсөн / өнөөдөр).</p>
        : kpi.unassigned ? <p data-lead-today className="rounded-xl border border-warn/40 bg-warn-soft px-4 py-2.5 text-[13.5px] font-semibold text-warn">🟠 Хуваарилагдаагүй {kpi.unassigned} «Шинэ» захиалга байна — өнөөдөртөө заавал хуваарилна уу.</p> : null}

      <div className="flex gap-1 rounded-lg bg-surface2 p-1 self-start">
        <span className="inline-flex h-8 items-center gap-1.5 rounded-md bg-surface px-3 text-[13px] font-semibold shadow-card"><Icon name="users" size={14} />Бүх захиалга</span>
        <span title="Модуль 5 (Жолооч)-д нэмэгдэнэ" className="inline-flex h-8 cursor-not-allowed items-center gap-1.5 px-3 text-[13px] font-semibold text-subtle"><Icon name="trend" size={14} />Жолоочийн гүйцэтгэл</span>
        <span title="Модуль 5 (Жолооч)-д нэмэгдэнэ" className="inline-flex h-8 cursor-not-allowed items-center gap-1.5 px-3 text-[13px] font-semibold text-subtle"><Icon name="chart" size={14} />График</span>
      </div>

      {/* Шүүлтүүр */}
      <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[200px] flex-1">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle"><Icon name="search" size={15} /></span>
            <input value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { setF(draft); setPage(1); } }}
              placeholder="Дугаар, утас, жолоочийн нэр…" className={clsx(fsel, 'w-full pl-8')} />
          </label>
          <select aria-label="Хуваарилалт" value={draft.assign} onChange={(e) => setDraft({ ...draft, assign: e.target.value })} className={fsel}>
            <option value="unassigned">Хуваарилаагүй</option><option value="assigned">Хуваарилсан</option><option value="all">Бүгд</option>
          </select>
          <input type="date" aria-label="Хүргэх огноо" title="Хүргэх огноо" value={draft.deliveryDate} onChange={(e) => setDraft({ ...draft, deliveryDate: e.target.value })} className={fsel} />
          <select aria-label="Төлөв" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })} className={fsel}>
            <option value="">Бүх төлөв</option><option value="NEW">Шинэ</option><option value="ASSIGNED">Жолоочид оноосон</option><option value="OUT_FOR_DELIVERY">Хүргэлтэд гарсан</option>
            <option value="DELIVERED">Хүргэсэн</option><option value="SCHEDULED">Он сар өдөртэй</option><option value="PENDING_PAYMENT">Төлбөр хүлээж буй</option><option value="CANCELLED">Цуцлагдсан</option>
          </select>
          <select aria-label="Жолооч" value={draft.driverId} onChange={(e) => setDraft({ ...draft, driverId: e.target.value })} className={fsel}>
            <option value="">Бүх жолооч</option>{drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button type="button" onClick={() => { setF(draft); setPage(1); }} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-[13px] font-semibold text-on-ink"><Icon name="search" size={14} />Хайх</button>
          <button type="button" onClick={() => { setDraft(EMPTY); setF(EMPTY); setPage(1); }} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold text-muted hover:text-ink"><Icon name="close" size={14} />Цэвэрлэх</button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[12px] text-muted">Үүссэн:</span>
          {chipDays.map((d) => (
            <button key={d} type="button" aria-pressed={draft.created === d} onClick={() => { const n = { ...draft, created: draft.created === d ? '' : d }; setDraft(n); setF(n); setPage(1); }}
              className={clsx('h-7 rounded-full border px-2.5 text-[12px] font-semibold', draft.created === d ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>{d === ubToday() ? `өнөөдөр ${md(d)}` : md(d)}</button>
          ))}
          <span className="mx-1 h-5 w-px bg-line" />
          <select aria-label="Дүүрэг" value={draft.district} onChange={(e) => { const n = { ...draft, district: e.target.value, rural: false }; setDraft(n); setF(n); setPage(1); }} className={clsx(fsel, 'h-7 text-[12px]')}>
            <option value="">Бүх дүүрэг</option>{Object.keys(UB_DISTRICTS).map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <button type="button" aria-pressed={draft.rural} onClick={() => { const n = { ...draft, rural: !draft.rural, district: '' }; setDraft(n); setF(n); setPage(1); }}
            className={clsx('h-7 rounded-full border px-2.5 text-[12px] font-semibold', draft.rural ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>Орон нутаг {RURAL.length}</button>
          <button type="button" aria-pressed={grouped} onClick={() => setGrouped(!grouped)}
            className={clsx('h-7 rounded-full border px-2.5 text-[12px] font-semibold', grouped ? 'border-teal-600 bg-teal-600 text-white' : 'border-teal-600/40 text-teal-700 dark:text-teal-300')}>Дүүргээр бүлэглэх</button>
          <select aria-label="Хуудасны хэмжээ" value={draft.pageSize} onChange={(e) => { const n = { ...draft, pageSize: Number(e.target.value) }; setDraft(n); setF(n); setPage(1); }} className={clsx(fsel, 'ml-auto h-7 text-[12px]')}>
            {[20, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n} мөр</option>)}
          </select>
        </div>
      </div>

      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}

      {canAssign && sel.size ? (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft p-2.5 shadow-card">
          <span className="font-bold">{sel.size} захиалга сонгогдсон</span>
          <DriverSelect drivers={drivers} value={bulkDriver} onChange={setBulkDriver} />
          <Button size="sm" variant="dark" disabled={!bulkDriver} loading={busy} onClick={() => assign([...sel], bulkDriver)}>Хуваарилах</Button>
          <span className="mx-1 h-6 w-px bg-line" />
          <input type="date" aria-label="Шинэ огноо" min={ubToday()} value={bulkDate} onChange={(e) => setBulkDate(e.target.value)} className={clsx(fsel, 'h-8')} />
          <Button size="sm" loading={busy} onClick={() => setDate([...sel], bulkDate)}>Огноо солих</Button>
          <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Болих</Button>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[1240px] text-[13px]">
          <thead className="border-b border-line bg-surface2/70">
            <tr>
              <th className="w-9 px-2.5 py-2">{canAssign ? <input type="checkbox" aria-label="Бүгдийг сонгох" className="h-4 w-4" checked={!!items.length && items.filter(editable).every((o) => sel.has(o.id))} onChange={(e) => setSel(e.target.checked ? new Set(items.filter(editable).map((o) => o.id)) : new Set())} /> : null}</th>
              <th className={clsx(th, 'w-[130px]')}>Дугаар</th><th className={clsx(th, 'w-[110px]')}>Үүссэн огноо</th><th className={clsx(th, 'min-w-[220px]')}>Бараа</th><th className={clsx(th, 'w-[140px]')}>Төлөв</th>
              <th className={th}>Хаяг</th><th className={clsx(th, 'w-[190px]')}>Жолооч</th><th className={clsx(th, 'w-[120px]')}>Огноо</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.key || 'all'} className="divide-y divide-line">
              {g.key ? <tr className="bg-teal-500/10"><td colSpan={8} className="px-3 py-1.5 font-bold text-teal-800 dark:text-teal-200">{g.key} <span className="ml-1 rounded-md bg-surface px-1.5 text-[11.5px]">{g.items.length}</span></td></tr> : null}
              {g.items.map((o) => (
                <tr key={o.id} className={clsx('align-top', sel.has(o.id) && 'bg-info-soft/40')}>
                  <td className="px-2.5 py-2">{editable(o) ? <input type="checkbox" aria-label={`№${o.number} сонгох`} className="h-4 w-4" checked={sel.has(o.id)} onChange={(e) => setSel((s) => { const x = new Set(s); if (e.target.checked) x.add(o.id); else x.delete(o.id); return x; })} /> : null}</td>
                  <td className="select-text px-2.5 py-2">
                    <div className="font-bold">№{o.number}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {o.postponeCount ? <span className="rounded bg-warn-soft px-1 text-[10.5px] font-bold text-warn">⏰ Маргааш</span> : null}
                      {o.handover ? <span className="rounded bg-info-soft px-1 text-[10.5px] font-bold text-info" title="Падаанд орсон">{o.handover.number}</span> : null}
                    </div>
                  </td>
                  <td className="px-2.5 py-2 text-[12px] text-muted">{ubDateTime(o.createdAt)}</td>
                  <td className="px-2.5 py-2">
                    {o.lines.slice(0, 3).map((l) => <div key={l.id} className="flex items-center gap-1.5"><Thumb src={l.thumb} alt={l.name} size={24} /><span className="line-clamp-1"><span className="text-subtle">[{l.code}]</span> {l.name}{l.label ? ` · ${l.label}` : ''} <b>{l.qty} ширхэг</b></span></div>)}
                    {o.lines.length > 1 ? <div className="text-[11.5px] text-subtle">Нийт: {o.lines.length} төрөл бараа · {money(o.total)}</div> : <div className="text-[11.5px] text-subtle">{money(o.total)}</div>}
                  </td>
                  <td className="px-2.5 py-2"><StatusChip o={o} /></td>
                  <td className="min-w-[240px] max-w-[300px] select-text px-2.5 py-2">
                    <div className="font-semibold">{o.phone}{o.extraPhone ? <span className="font-normal text-muted"> · {o.extraPhone}</span> : null}</div>
                    <div className="line-clamp-2 text-[12.5px]" title={o.fullAddress}>{o.fullAddress}</div>
                    {o.note ? <OperatorNote text={o.note} className="!line-clamp-3" /> : null}
                  </td>
                  <td className="px-2.5 py-2">
                    {editable(o) ? <DriverSelect drivers={drivers} value={o.driverId ?? ''} onChange={(v) => { if (v) assign([o.id], v); }} disabled={busy} />
                      : <span className={o.driverName ? 'font-semibold' : 'text-subtle'}>{o.driverName ?? '—'}</span>}
                  </td>
                  <td className="px-2.5 py-2">
                    {editable(o) ? <input type="date" aria-label={`№${o.number} огноо`} min={ubToday()} value={o.deliveryDate} disabled={busy} onChange={(e) => { if (e.target.value && e.target.value !== o.deliveryDate) setDate([o.id], e.target.value); }} className={clsx(fsel, 'h-8 w-[118px] text-[12px]', o.isToday && 'border-bad text-bad-ink')} />
                      : <span className="text-[12.5px]">{md(o.deliveryDate)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
        {data && !items.length ? <p className="p-8 text-center text-muted">Захиалга алга</p> : null}
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
      <ByDayDrawer open={byDayOpen} onClose={() => setByDayOpen(false)} />
    </div>
  );
}

/** Жолооч сонгох — нэрний хажууд ачаалал (20+ улаан, 10+ шар) */
function DriverSelect({ drivers, value, onChange, disabled }: { drivers: Driver[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const cur = drivers.find((d) => d.id === value);
  return (
    <span className="inline-flex items-center gap-1">
      <select aria-label="Жолооч сонгох" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={clsx(fsel, 'h-8 w-[150px] text-[12.5px]', !value && 'text-subtle')}>
        <option value="">— Жолооч —</option>
        {drivers.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.load})</option>)}
      </select>
      {cur ? <span title="Маргаашийн ачаалал" className={clsx('rounded px-1 text-[10.5px] font-bold', loadTone(cur.load))}>{cur.load}</span> : null}
    </span>
  );
}

/** «Жолоочдын захиалга» — жолооч бүрийн өдрийн захиалга (баруун самбар) */
function ByDayDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [date, setDate] = useState(ubToday(1));
  const [d, setD] = useState<{ drivers: { driverId: string; driverName: string; orders: LItem[] }[] } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => { if (open) { setD(null); api<NonNullable<typeof d>>(`/api/driver-lead/drivers?byDay=1&date=${date}`).then(setD).catch(() => undefined); } }, [open, date]);
  return (
    <Modal open={open} onClose={onClose} size="drawer" title="📦 Жолоочдын захиалга">
      <div className="flex flex-col gap-3 text-[13px]">
        <div className="flex gap-1.5">
          {[0, 1].map((o) => ubToday(o)).map((x) => <button key={x} type="button" aria-pressed={date === x} onClick={() => setDate(x)} className={clsx('h-8 rounded-lg border px-3 text-[12px] font-semibold', date === x ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>{x === ubToday() ? 'Өнөөдөр' : 'Маргааш'}</button>)}
          <input type="date" aria-label="Огноо" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className={clsx(fsel, 'h-8')} />
        </div>
        {!d ? <p className="py-6 text-center text-muted">Ачаалж байна…</p> : !d.drivers.length ? <p className="py-6 text-center text-subtle">Энэ өдөр хуваарилсан захиалга алга</p> : d.drivers.map((g) => (
          <div key={g.driverId} className="overflow-hidden rounded-lg border border-line">
            <button type="button" aria-expanded={openId === g.driverId} onClick={() => setOpenId(openId === g.driverId ? null : g.driverId)} className="flex w-full items-center justify-between bg-surface2/70 px-3 py-2 font-semibold">
              <span>{g.driverName}</span><span className="flex items-center gap-2"><span className="rounded-md bg-surface px-2 text-[12px]">{g.orders.length}</span><Icon name={openId === g.driverId ? 'up' : 'down'} size={14} /></span>
            </button>
            {openId === g.driverId ? (
              <ul className="divide-y divide-line">
                {g.orders.map((o) => (
                  <li key={o.id} className="flex flex-col gap-0.5 px-3 py-2">
                    <span className="flex flex-wrap items-center gap-2"><b>№{o.number}</b>{o.postponeCount ? <span className="rounded bg-warn-soft px-1 text-[10.5px] font-bold text-warn">Маргааш</span> : null}<span>{o.phone}</span><StatusChip o={o} /><span className="ml-auto text-subtle">{md(o.deliveryDate)}</span></span>
                    <span className="text-[12px] text-muted">{o.lines.map((l) => `${l.name}${l.label ? ` · ${l.label}` : ''} ${l.qty}ш`).join(', ')}</span>
                    <span className="text-[12px]">{o.fullAddress}</span>
                    {o.note ? <OperatorNote text={o.note} /> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** Ахлах жолооч: «Бүх захиалга» (хуваарилах) · «Жолоочийн гүйцэтгэл» · «График» (хуучин шиг) */
export function DriverLeadClient() {
  const [tab, setTab] = useState<'orders' | 'performance' | 'chart'>('orders');
  const [drivers, setDrivers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { if (tab !== 'orders' && !drivers.length) api<{ items: { id: string; name: string }[] }>('/api/driver-lead/drivers').then((r) => setDrivers(r.items)).catch(() => undefined); }, [tab, drivers.length]);
  return (
    <div className="flex flex-col gap-3">
      {tab !== 'orders' ? <h1 className="text-[24px] font-extrabold tracking-tight">Ахлах жолооч</h1> : null}
      <div className="flex gap-1.5 overflow-x-auto" role="tablist" data-overflow-ok>
        {([['orders', 'Бүх захиалга'], ['performance', 'Жолоочийн гүйцэтгэл'], ['chart', 'График']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={clsx('h-10 shrink-0 rounded-full border px-4 text-[13.5px] font-bold', tab === k ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-muted')}>{l}</button>
        ))}
      </div>
      {tab === 'orders' ? <AssignView /> : tab === 'performance' ? <PerformanceTab drivers={drivers} /> : <ChartTab drivers={drivers} />}
    </div>
  );
}
