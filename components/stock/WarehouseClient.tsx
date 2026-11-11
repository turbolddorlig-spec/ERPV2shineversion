'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Field } from '@/components/ui/Field';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';

interface Wh { id: number; name: string; isPrimary: boolean }
interface Row {
  variantId: number; productId: number; code: string; name: string; label: string; thumb: string | null; shelfCode: string | null; isActive: boolean;
  byWarehouse: Record<string, number>; transit: number; staff: number; driver: number; drivers: { name: string; qty: number }[]; total: number; reserved: number; reservedPending: number; available: number;
}
interface StockResp { items: Row[]; page: number; pageSize: number; hasMore: boolean; warehouses: Wh[]; canOperate: boolean }
interface Today { refill: number; incoming: number; discrepancy: number; loanRequests: number; countsToApprove: number; openCounts: number; returns: number; approver: boolean }
interface Rec { ok: boolean; mismatches: unknown[]; moves: number; checkedAt: string }

/** «Өнөөдрийн ажил» карт — дарахад тэр ажил руу шууд орно */
function WorkCard({ n, label, hint, href, tone = 'accent', disabled }: { n: number; label: string; hint?: string; href: string; tone?: 'accent' | 'bad' | 'neutral'; disabled?: boolean }) {
  const active = n > 0 && !disabled;
  const body = (
    <>
      <span className={clsx('text-[28px] font-extrabold leading-none tracking-[-0.03em]', active ? (tone === 'bad' ? 'text-bad-ink' : 'text-accent-ink') : 'text-subtle')}>{disabled ? '—' : n}</span>
      <span className="text-[14px] font-bold">{label}</span>
      {hint ? <span className="text-[12px] text-subtle">{hint}</span> : null}
    </>
  );
  const cls = clsx('flex min-h-[104px] flex-col gap-1.5 rounded-[16px] border p-3.5', active ? 'border-accent/40 bg-accent-soft/60 hover:bg-accent-soft' : 'border-line bg-surface', disabled && 'opacity-70');
  return disabled ? <div className={cls} aria-disabled="true">{body}</div> : <Link href={href} className={cls}>{body}</Link>;
}

/** Жолоочид явж буй бараа: тоон дээр дарахад аль жолоочид хэдэн ширхэг байгааг харуулна */
function DriverQty({ r, mobile }: { r: { driver: number; drivers: { name: string; qty: number }[] }; mobile?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block text-left">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} title="Аль жолоочид байгааг харах"
        className={clsx('font-bold text-info underline decoration-dotted underline-offset-2', mobile && 'rounded-lg bg-info-soft px-2 py-1 no-underline')}>
        {mobile ? `Жолоочид: ${r.driver}` : r.driver}
      </button>
      {open ? (
        <span className={clsx('absolute z-30 mt-1 flex w-[220px] flex-col gap-0.5 rounded-xl border border-line bg-surface p-2 text-[12.5px] shadow-pop', mobile ? 'left-0' : 'right-0')}>
          {r.drivers.map((d) => <span key={d.name} className="flex justify-between gap-2"><span className="min-w-0 [overflow-wrap:anywhere]">{d.name}</span><b className="whitespace-nowrap">{d.qty}ш</b></span>)}
        </span>
      ) : null}
    </span>
  );
}

export function WarehouseClient({ canOperate, canApprove }: { canOperate: boolean; canApprove: boolean }) {
  const [today, setToday] = useState<Today | null>(null);
  const [rec, setRec] = useState<Rec | null>(null);
  const [q, setQ] = useState('');
  const [wh, setWh] = useState('');
  const [inStock, setInStock] = useState(true);
  const [sort, setSort] = useState('code');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<StockResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [shelfOpen, setShelfOpen] = useState(false);
  const [shelf, setShelf] = useState('');
  const [shelfErr, setShelfErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    const f = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('done') : null;
    if (f) setFlash(f);
    api<Today>('/api/stock/today').then(setToday).catch(() => undefined);
    api<Rec>('/api/stock/reconcile').then(setRec).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    const sp = new URLSearchParams({ page: String(page), sort });
    if (q.trim()) sp.set('q', q.trim());
    if (wh) sp.set('warehouseId', wh);
    if (inStock) sp.set('inStock', '1');
    try {
      const r = await api<StockResp>(`/api/stock?${sp}`);
      if (id === reqId.current) { setData(r); setError(null); }
    } catch (e) { if (id === reqId.current) setError(e instanceof ApiError ? e.message : 'Ачаалж чадсангүй'); }
  }, [q, wh, inStock, sort, page]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  const whs = data?.warehouses ?? [];
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function saveShelf() {
    setShelfErr(null);
    const productIds = [...new Set((data?.items ?? []).filter((r) => selected.has(r.variantId)).map((r) => r.productId))];
    try {
      const r = await api<{ updated: number; shelfCode: string | null }>('/api/stock/shelf', { method: 'POST', json: { productIds, shelfCode: shelf } });
      setShelfOpen(false); setSelected(new Set()); setShelf('');
      setFlash(r.shelfCode ? `${r.updated} барааг «${r.shelfCode}» тавиурт оноолоо` : `${r.updated} барааг тавиураас хаслаа`);
      load();
    } catch (e) { setShelfErr(e instanceof ApiError ? e.message : 'Алдаа'); }
  }

  return (
    <div className="flex flex-col gap-5">
      {flash ? <Notice tone="ok">{flash}</Notice> : null}

      {canOperate ? (
        <div className="flex flex-wrap gap-2">
          <Link href="/warehouse/receipt" className="inline-flex h-11 items-center gap-2 rounded-[11px] bg-accent px-4 text-[14px] font-bold text-on-accent"><Icon name="plus" size={16} strokeWidth={2.4} />Орлого</Link>
          <Link href="/warehouse/transfers/new" className="inline-flex h-11 items-center gap-2 rounded-[11px] border border-line bg-surface px-4 text-[14px] font-semibold"><Icon name="swap" size={16} />Шилжүүлэг</Link>
          <Link href="/warehouse/issue" className="inline-flex h-11 items-center gap-2 rounded-[11px] border border-line bg-surface px-4 text-[14px] font-semibold"><Icon name="down" size={16} />Зарлага</Link>
          <Link href="/warehouse/counts" className="inline-flex h-11 items-center gap-2 rounded-[11px] border border-line bg-surface px-4 text-[14px] font-semibold"><Icon name="check" size={16} />Тооллого</Link>
          <span className="inline-flex h-11 cursor-not-allowed items-center gap-2 rounded-[11px] border border-dashed border-line px-4 text-[14px] font-semibold text-subtle" title="Жолоочид бараа өгөх (Модуль 4)-өөс эхэлж ажиллана">
            <Icon name="refresh" size={16} />Буцаалт авах
          </span>
        </div>
      ) : null}

      <section aria-labelledby="today-h" className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="today-h" className="text-[16px] font-extrabold">Өнөөдрийн ажил</h2>
          {rec ? (
            <span className={clsx('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-bold', rec.ok ? 'bg-ok-soft text-ok-ink' : 'bg-bad-soft text-bad-ink')}
              title={`Шалгасан: ${new Date(rec.checkedAt).toLocaleString('mn-MN')} · ${rec.moves.toLocaleString('mn-MN')} хөдөлгөөн`}>
              <Icon name={rec.ok ? 'check' : 'alert'} size={14} />{rec.ok ? 'Журнал = үлдэгдэл, зөрүүгүй' : `Тулгалтын зөрүү: ${rec.mismatches.length}`}
            </span>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          <WorkCard n={today?.refill ?? 0} label="Дүүргэх бараа" hint="Үндсэн тавиурт дутуу" href="/warehouse/refill" tone="bad" />
          <WorkCard n={today?.incoming ?? 0} label="Ирэх шилжүүлэг" hint="Хүлээн авах" href="/warehouse/transfers?status=SENT" />
          <WorkCard n={today?.loanRequests ?? 0} label="Зээлийн хүсэлт" hint="Олгох" href="/loans?status=REQUESTED" />
          <WorkCard n={0} label="Буцаалт хүлээн авах" hint="Модуль 4–5-аас" href="#" disabled />
          {today?.approver || canApprove ? (
            <>
              <WorkCard n={today?.countsToApprove ?? 0} label="Батлах тооллого" href="/warehouse/counts?status=SUBMITTED" />
              <WorkCard n={today?.discrepancy ?? 0} label="Дутуу ирсэн шилжүүлэг" hint="Шийдэх" href="/warehouse/transfers?status=DISCREPANCY" tone="bad" />
            </>
          ) : <WorkCard n={today?.openCounts ?? 0} label="Нээлттэй тооллого" href="/warehouse/counts?status=OPEN" />}
        </div>
      </section>

      <section aria-labelledby="stock-h" className="flex flex-col gap-3">
        <h2 id="stock-h" className="text-[16px] font-extrabold">Үлдэгдэл</h2>
        <div className="flex flex-wrap gap-2">
          <label className="relative min-w-[220px] flex-1">
            <span className="sr-only">Хайх</span>
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle"><Icon name="search" size={17} /></span>
            <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Код, нэр, өнгөөр хайх" className="h-11 w-full rounded-xl border border-line bg-surface pl-10 pr-3 outline-none focus:border-accent" />
          </label>
          <select aria-label="Агуулах" value={wh} onChange={(e) => { setWh(e.target.value); setPage(1); }} className="h-11 rounded-xl border border-line bg-surface px-3">
            <option value="">Бүх агуулах</option>
            {whs.map((w) => <option key={w.id} value={w.id}>{w.name}{w.isPrimary ? ' (үндсэн)' : ''}</option>)}
          </select>
          <select aria-label="Эрэмбэ" value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} className="h-11 rounded-xl border border-line bg-surface px-3">
            <option value="code">Кодоор</option>
            <option value="shelf">Тавиураар</option>
          </select>
          <label className="inline-flex h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-[13.5px] font-semibold">
            <input type="checkbox" checked={inStock} onChange={(e) => { setInStock(e.target.checked); setPage(1); }} className="h-[18px] w-[18px] accent-[var(--accent)]" />Зөвхөн үлдэгдэлтэй
          </label>
        </div>

        {canOperate && selected.size ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-accent-soft px-3.5 py-2.5">
            <span className="text-[14px] font-bold">{selected.size} мөр сонгосон</span>
            <Button size="sm" onClick={() => { setShelfErr(null); setShelfOpen(true); }}>Тавиур оноох</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Болих</Button>
          </div>
        ) : null}
        {error ? <Notice>{error}</Notice> : null}

        <div className="hidden overflow-hidden rounded-[16px] border border-line bg-surface shadow-card md:block">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] border-collapse text-[13.5px]">
              <thead>
                <tr className="bg-surface2 text-left text-[12px] text-muted">
                  {canOperate ? <th scope="col" className="w-10 border-b border-line py-2.5 pl-4"><span className="sr-only">Сонгох</span></th> : null}
                  <th scope="col" className="border-b border-line px-3 py-2.5 font-bold">Бараа</th>
                  <th scope="col" className="border-b border-line px-2 py-2.5 font-bold">Тавиур</th>
                  {whs.map((w) => <th key={w.id} scope="col" className="border-b border-line px-2 py-2.5 text-right font-bold">{w.isPrimary ? '★ ' : ''}{w.name}</th>)}
                  <th scope="col" className="border-b border-line px-2 py-2.5 text-right font-bold">Замдаа</th>
                  <th scope="col" className="border-b border-line px-2 py-2.5 text-right font-bold">Зээлд</th>
                  <th scope="col" className="border-b border-line px-2 py-2.5 text-right font-bold" title="Падаанаар жолоочид өгсөн, хүргэлтэд явж буй бараа">Жолоочид</th>
                  <th scope="col" className="border-b border-line px-2 py-2.5 text-right font-bold">Нийт</th>
                  <th scope="col" className="border-b border-line px-2 py-2.5 text-right font-bold">Захиалгад</th>
                  <th scope="col" className="border-b border-line px-2 py-2.5 text-right font-bold">Боломжтой</th>
                  <th scope="col" className="border-b border-line px-3 py-2.5"><span className="sr-only">Үйлдэл</span></th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((r) => (
                  <tr key={r.variantId} className={clsx('hover:bg-surface2/60', selected.has(r.variantId) && 'bg-accent-soft/50', !r.isActive && 'opacity-60')}>
                    {canOperate ? <td className="border-b border-line py-2 pl-4"><input type="checkbox" aria-label={`${r.code} сонгох`} checked={selected.has(r.variantId)} onChange={() => toggle(r.variantId)} className="h-[18px] w-[18px] accent-[var(--accent)]" /></td> : null}
                    <td className="min-w-[260px] max-w-[360px] border-b border-line px-3 py-2">
                      <div className="flex items-center gap-2.5">
                        <Thumb src={r.thumb} alt={`${r.name} ${r.label}`} size={38} zoom={r.code} />
                        <span className="flex min-w-0 select-text flex-col leading-tight"><span className="line-clamp-2 font-semibold" title={`${r.name}${r.label ? ` · ${r.label}` : ''}`}>{r.name}{r.label ? <span className="text-muted"> · {r.label}</span> : null}</span><span className="text-[12px] text-subtle">{r.code}</span></span>
                      </div>
                    </td>
                    <td className="border-b border-line px-2 py-2 font-semibold">{r.shelfCode ?? <span className="text-subtle">—</span>}</td>
                    {whs.map((w) => { const n = r.byWarehouse[w.id] ?? 0; return <td key={w.id} className={clsx('border-b border-line px-2 py-2 text-right', n ? 'font-bold' : 'text-subtle')}>{n || '·'}</td>; })}
                    <td className="border-b border-line px-2 py-2 text-right text-info">{r.transit || ''}</td>
                    <td className="border-b border-line px-2 py-2 text-right text-muted">{r.staff || ''}</td>
                    <td className="border-b border-line px-2 py-2 text-right">{r.driver ? <DriverQty r={r} /> : ''}</td>
                    <td className="border-b border-line px-2 py-2 text-right font-extrabold">{r.total}</td>
                    <td className="border-b border-line px-2 py-2 text-right text-muted">{r.reserved || ''}{r.reservedPending ? <span className="block text-[11px] text-warn" title="Төлбөр хүлээж буй захиалгад">{r.reservedPending} төлб.</span> : null}</td>
                    <td className={clsx('border-b border-line px-2 py-2 text-right font-bold', r.available < 0 ? 'text-bad-ink' : 'text-ok-ink')}>{r.available}</td>
                    <td className="border-b border-line px-3 py-2"><RowActions r={r} canOperate={canOperate} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <ul className="flex flex-col gap-2 md:hidden">
          {data?.items.map((r) => (
            <li key={r.variantId} className={clsx('flex flex-col gap-2.5 rounded-[16px] border border-line bg-surface p-3 shadow-card', !r.isActive && 'opacity-60')}>
              <div className="flex items-center gap-3">
                {canOperate ? <input type="checkbox" aria-label={`${r.code} сонгох`} checked={selected.has(r.variantId)} onChange={() => toggle(r.variantId)} className="h-5 w-5 shrink-0 accent-[var(--accent)]" /> : null}
                <Thumb src={r.thumb} alt={`${r.name} ${r.label}`} size={52} zoom={r.code} />
                <span className="flex min-w-0 flex-1 select-text flex-col">
                  <span className="text-[15px] font-bold">{r.name}{r.label ? <span className="text-muted"> · {r.label}</span> : null}</span>
                  <span className="text-[12.5px] text-subtle">{r.code}{r.shelfCode ? ` · Тавиур ${r.shelfCode}` : ''}</span>
                </span>
                <span className="text-right"><span className="block text-[20px] font-extrabold leading-none">{r.total}</span><span className="text-[11.5px] text-subtle">нийт</span></span>
              </div>
              <div className="flex flex-wrap gap-1.5 text-[12.5px]">
                {whs.filter((w) => r.byWarehouse[w.id]).map((w) => <span key={w.id} className="rounded-lg bg-surface2 px-2 py-1 font-semibold">{w.isPrimary ? '★ ' : ''}{w.name}: {r.byWarehouse[w.id]}</span>)}
                {r.transit ? <span className="rounded-lg bg-info-soft px-2 py-1 font-semibold text-info">Замдаа: {r.transit}</span> : null}
                {r.staff ? <span className="rounded-lg bg-surface2 px-2 py-1 font-semibold">Зээлд: {r.staff}</span> : null}
                {r.driver ? <DriverQty r={r} mobile /> : null}
                {r.reserved ? <span className="rounded-lg bg-surface2 px-2 py-1 font-semibold">Захиалгад: {r.reserved}{r.reservedPending ? ` (төлбөр хүлээж буй ${r.reservedPending})` : ''}</span> : null}
                <span className={clsx('rounded-lg px-2 py-1 font-bold', r.available < 0 ? 'bg-bad-soft text-bad-ink' : 'bg-ok-soft text-ok-ink')}>Боломжтой: {r.available}</span>
              </div>
              <RowActions r={r} canOperate={canOperate} mobile />
            </li>
          ))}
        </ul>

        {data && data.items.length === 0 ? <div className="rounded-[16px] border border-dashed border-line bg-surface p-8 text-center text-muted">{whs.length ? 'Бараа олдсонгүй' : 'Агуулах бүртгэгдээгүй байна. «Агуулахууд» хэсэгт нэмнэ үү.'}</div> : null}
        {!data && !error ? <p className="py-6 text-center text-muted">Ачаалж байна…</p> : null}
        {data && (page > 1 || data.hasMore) ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] text-muted">{page}-р хуудас</span>
            <div className="flex gap-2">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><Icon name="left" size={15} /> Өмнөх</Button>
              <Button size="sm" disabled={!data.hasMore} onClick={() => setPage((p) => p + 1)}>Дараах <Icon name="right" size={15} /></Button>
            </div>
          </div>
        ) : null}
      </section>

      <Modal open={shelfOpen} onClose={() => setShelfOpen(false)} title="Тавиур оноох"
        footer={<><Button onClick={() => setShelfOpen(false)}>Болих</Button><Button variant="primary" onClick={saveShelf}>Хадгалах</Button></>}>
        <div className="flex flex-col gap-3">
          <p className="text-[14px] text-muted">Сонгосон мөрийн бараа (бүх өнгө, хэмжээ) энэ тавиурт байрлана. Хоосон орхивол тавиураас хасна.</p>
          <Field id="shelf" label="Тавиурын код" placeholder="A-3" value={shelf} onChange={(e) => setShelf(e.target.value.toUpperCase())} error={shelfErr} autoFocus maxLength={12} />
        </div>
      </Modal>
    </div>
  );
}

/** Мөрийн үйлдэл: түүх, шилжүүлэх, зарлага — нэг товчоор (#39) */
function RowActions({ r, canOperate, mobile }: { r: Row; canOperate: boolean; mobile?: boolean }) {
  const cls = clsx('inline-flex items-center gap-1 rounded-[10px] border border-line bg-surface font-semibold hover:bg-surface2', mobile ? 'h-10 flex-1 justify-center px-2 text-[13px]' : 'h-8 px-2 text-[12.5px]');
  return (
    <div className={clsx('flex gap-1.5', !mobile && 'justify-end')}>
      <Link href={`/warehouse/products/${r.productId}?variantId=${r.variantId}`} className={cls}><Icon name="history" size={14} />Түүх</Link>
      {canOperate && r.total > 0 ? <Link href={`/warehouse/transfers/new?lines=${r.variantId}:1`} className={cls}><Icon name="swap" size={14} />Шилжүүлэх</Link> : null}
      {canOperate && r.total > 0 ? <Link href={`/warehouse/issue?lines=${r.variantId}:1`} className={cls}><Icon name="down" size={14} />Зарлага</Link> : null}
    </div>
  );
}
