'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { ReasonModal } from '@/components/ui/ReasonModal';
import { Modal } from '@/components/ui/Modal';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { CATEGORY_DOT, money } from '@/lib/format';

interface Item {
  id: number; code: string; name: string; price: number; costPrice?: number | null; status: 'ACTIVE' | 'DISCONTINUED' | 'ARCHIVED';
  statusLabel: string; category: { id: number; name: string; color: string } | null; season: { id: number; name: string } | null;
  variantCount: number; hasVariants: boolean; thumb: string | null; variants: Variant[];
}
interface Variant { id: number; code: string; color: string; size: string; label: string; isActive: boolean; price: number; priceOverride: boolean; thumb: string | null }
interface ListResp { items: Item[]; total: number; page: number; pageSize: number }
interface Opt { id: number; name: string; color: string; isActive: boolean }

const STATUS = [
  { v: 'live', l: 'Зарагдаж буй' }, { v: 'active', l: 'Идэвхтэй' }, { v: 'discontinued', l: 'Зогсоосон' }, { v: 'archived', l: 'Архив' }, { v: 'all', l: 'Бүгд' },
];

export function StatusBadge({ status, label }: { status: Item['status']; label: string }) {
  return <Badge tone={status === 'ACTIVE' ? 'ok' : status === 'DISCONTINUED' ? 'warn' : 'neutral'}>{label}</Badge>;
}

export function Thumb({ src, alt, size = 44 }: { src: string | null; alt: string; size?: number }) {
  return src
    ? <img src={src} alt={alt} loading="lazy" width={size} height={size} className="shrink-0 rounded-[10px] bg-surface2 object-cover" style={{ width: size, height: size }} />
    : <span aria-hidden="true" className="grid shrink-0 place-items-center rounded-[10px] bg-surface2 text-subtle" style={{ width: size, height: size }}><Icon name="image" size={Math.round(size / 2.4)} /></span>;
}

export function ProductsClient({ canEdit, showCost, canManageLists, canSeeHistory }: { canEdit: boolean; showCost: boolean; canManageLists: boolean; canSeeHistory: boolean }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('live');
  const [categoryId, setCategoryId] = useState('');
  const [seasonId, setSeasonId] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cats, setCats] = useState<Opt[]>([]);
  const [seasons, setSeasons] = useState<Opt[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkCat, setBulkCat] = useState('');
  const [reasonOpen, setReasonOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const reqId = useRef(0);
  // Хувилбарыг бараа бүрийн доор догол мөрөөр харуулна; хүсвэл хураана
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const toggleOpen = (id: number) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  useEffect(() => {
    api<{ items: Opt[] }>('/api/catalog/categories').then((r) => setCats(r.items)).catch(() => undefined);
    api<{ items: Opt[] }>('/api/catalog/seasons').then((r) => setSeasons(r.items)).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true); setError(null);
    const sp = new URLSearchParams({ status, page: String(page) });
    if (q.trim()) sp.set('q', q.trim());
    if (categoryId) sp.set('categoryId', categoryId);
    if (seasonId) sp.set('seasonId', seasonId);
    try {
      const r = await api<ListResp>(`/api/products?${sp}`);
      if (id === reqId.current) setData(r);
    } catch (e) {
      if (id === reqId.current) setError(e instanceof ApiError ? e.message : 'Ачаалж чадсангүй');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [q, status, categoryId, seasonId, page]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 4000); return () => clearTimeout(t); }, [flash]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function bulkAssign(reason: string) {
    setBusy(true);
    try {
      const r = await api<{ changed: number }>('/api/products/bulk-category', { method: 'POST', json: { productIds: [...selected], categoryId: bulkCat ? Number(bulkCat) : null, reason } });
      setFlash(`${r.changed} барааны ангилал солигдлоо`);
      setSelected(new Set()); setReasonOpen(false); setBulkOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Алдаа гарлаа'); setReasonOpen(false);
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-11 min-w-0 flex-[1_1_260px] items-center gap-2 rounded-xl border border-line bg-surface px-3 text-subtle md:h-10">
          <Icon name="search" size={16} />
          <span className="sr-only">Хайх</span>
          <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Код эсвэл нэрээр хайх"
            className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-subtle" />
        </label>
        <Select id="f-cat" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setPage(1); }} className="flex-[1_1_150px] md:flex-none" aria-label="Ангилал">
          <option value="">Бүх ангилал</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select id="f-season" value={seasonId} onChange={(e) => { setSeasonId(e.target.value); setPage(1); }} className="flex-[1_1_130px] md:flex-none" aria-label="Улирал">
          <option value="">Бүх улирал</option>
          {seasons.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Төлөв" className="flex gap-1.5 overflow-x-auto">
          {STATUS.map((s) => (
            <button key={s.v} type="button" aria-pressed={status === s.v} onClick={() => { setStatus(s.v); setPage(1); }}
              className={clsx('h-10 shrink-0 rounded-full border px-4 text-[13.5px] font-semibold', status === s.v ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-ink')}>
              {s.l}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {canSeeHistory ? <Link href="/products/history" className="inline-flex h-10 items-center gap-2 rounded-[11px] border border-line bg-surface px-3 text-[13.5px] font-semibold"><Icon name="history" size={16} />Засварын түүх</Link> : null}
          {canManageLists ? <Link href="/products/catalog" className="inline-flex h-10 items-center rounded-[11px] border border-line bg-surface px-3 text-[13.5px] font-semibold">Ангилал, улирал</Link> : null}
          <a href="/api/products/export" className="inline-flex h-10 items-center gap-2 rounded-[11px] border border-line bg-surface px-3 text-[13.5px] font-semibold"><Icon name="download" size={16} />Excel</a>
          {canEdit ? <Link href="/products/new" className="inline-flex h-10 items-center gap-2 rounded-[11px] bg-accent px-4 text-[14px] font-bold text-on-accent"><Icon name="plus" size={16} strokeWidth={2.4} />Бараа нэмэх</Link> : null}
        </div>
      </div>

      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}

      {canEdit && selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-accent-soft px-3 py-2.5">
          <span className="text-[13.5px] font-bold text-accent-ink">{selected.size} бараа сонгосон</span>
          <span className="flex-1" />
          <Button size="sm" onClick={() => setBulkOpen(true)}>Ангилал оноох</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Болих</Button>
        </div>
      ) : null}

      <div className="hidden overflow-hidden rounded-[16px] border border-line bg-surface shadow-card md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-[13.5px]">
            <thead>
              <tr className="bg-surface2 text-left text-[12px] text-muted">
                {canEdit ? <th scope="col" className="w-11 border-b border-line py-2.5 pl-4"><span className="sr-only">Сонгох</span></th> : null}
                <th scope="col" className="border-b border-line px-3 py-2.5 font-bold">Бараа</th>
                <th scope="col" className="border-b border-line px-3 py-2.5 font-bold">Ангилал</th>
                <th scope="col" className="border-b border-line px-3 py-2.5 text-right font-bold">Үнэ</th>
                {showCost ? <th scope="col" className="border-b border-line px-3 py-2.5 text-right font-bold">Өртөг</th> : null}
                <th scope="col" className="border-b border-line px-3 py-2.5 font-bold">Хувилбар</th>
                <th scope="col" className="border-b border-line px-3 py-2.5 font-bold">Төлөв</th>
                {canEdit ? <th scope="col" className="border-b border-line px-3 py-2.5"><span className="sr-only">Үйлдэл</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {data?.items.map((p) => (
                <Fragment key={p.id}>
                <tr className={clsx(selected.has(p.id) && 'bg-accent-soft/50', 'hover:bg-surface2/60')}>
                  {canEdit ? <td className="border-b border-line py-2 pl-4"><input type="checkbox" aria-label={`${p.code} сонгох`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} className="h-[18px] w-[18px] accent-[var(--accent)]" /></td> : null}
                  <td className="border-b border-line px-3 py-2">
                    <Link href={`/products/${p.id}`} className="flex items-center gap-3">
                      <Thumb src={p.thumb} alt={p.name} />
                      <span className="flex min-w-0 flex-col"><span className="truncate font-semibold">{p.name}</span><span className="text-[12px] text-subtle">{p.code}</span></span>
                    </Link>
                  </td>
                  <td className="border-b border-line px-3 py-2">
                    {p.category ? <span className="inline-flex items-center gap-1.5 text-[13px]"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-[3px]" style={{ background: CATEGORY_DOT[p.category.color] }} />{p.category.name}</span> : <span className="text-subtle">—</span>}
                    {p.season ? <span className="block text-[12px] text-subtle">{p.season.name}</span> : null}
                  </td>
                  <td className="border-b border-line px-3 py-2 text-right font-bold">{money(p.price)}</td>
                  {showCost ? <td className="border-b border-line px-3 py-2 text-right text-muted">{money(p.costPrice)}</td> : null}
                  <td className="border-b border-line px-3 py-2 text-muted">{p.variants.length ? (
                    <button type="button" aria-expanded={!collapsed.has(p.id)} onClick={() => toggleOpen(p.id)} className="inline-flex items-center gap-1 rounded-lg px-1.5 py-1 font-semibold text-ink hover:bg-surface2">
                      {p.variantCount} хувилбар <Icon name={collapsed.has(p.id) ? 'right' : 'down'} size={14} />
                    </button>
                  ) : 'Үндсэн'}</td>
                  <td className="border-b border-line px-3 py-2"><StatusBadge status={p.status} label={p.statusLabel} /></td>
                  {canEdit ? <td className="border-b border-line px-3 py-2 text-right"><Link href={`/products/${p.id}?edit=1`} aria-label={`${p.code} засах`} className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line bg-surface px-3 text-[13px] font-semibold hover:bg-surface2"><Icon name="edit" size={15} />Засах</Link></td> : null}
                </tr>
                {!collapsed.has(p.id) ? p.variants.map((v) => (
                  <tr key={`v${v.id}`} className={clsx('bg-surface2/30 text-[13px]', !v.isActive && 'opacity-55')}>
                    {canEdit ? <td className="border-b border-line/60" /> : null}
                    <td className="border-b border-line/60 py-1.5 pl-10 pr-3">
                      <span className="flex items-center gap-2.5">
                        <span aria-hidden="true" className="h-5 w-3 shrink-0 rounded-bl-md border-b-2 border-l-2 border-line" />
                        <Thumb src={v.thumb} alt={v.label} size={30} />
                        <span className="flex min-w-0 flex-col leading-tight"><span className="font-semibold">{v.label}</span><span className="text-[11.5px] text-subtle">{v.code}</span></span>
                      </span>
                    </td>
                    <td className="border-b border-line/60 px-3 py-1.5" />
                    <td className={clsx('border-b border-line/60 px-3 py-1.5 text-right font-semibold', v.priceOverride && 'text-accent-ink')}>{money(v.price)}</td>
                    {showCost ? <td className="border-b border-line/60 px-3 py-1.5 text-right text-subtle">{money(p.costPrice)}</td> : null}
                    <td className="border-b border-line/60 px-3 py-1.5 text-[12px] text-subtle">{v.priceOverride ? 'Тусдаа үнэ' : ''}</td>
                    <td className="border-b border-line/60 px-3 py-1.5">{v.isActive ? null : <Badge tone="neutral">Идэвхгүй</Badge>}</td>
                    {canEdit ? <td className="border-b border-line/60" /> : null}
                  </tr>
                )) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ul className="flex flex-col gap-2 md:hidden">
        {data?.items.map((p) => (
          <li key={p.id} className="flex flex-col gap-2 rounded-[16px] border border-line bg-surface p-3 shadow-card">
            <div className="flex items-center gap-3">
            {canEdit ? <input type="checkbox" aria-label={`${p.code} сонгох`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} className="h-5 w-5 shrink-0 accent-[var(--accent)]" /> : null}
            <Link href={`/products/${p.id}`} className="flex min-w-0 flex-1 items-center gap-3">
              <Thumb src={p.thumb} alt={p.name} size={56} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[15px] font-bold">{p.name}</span>
                <span className="text-[12.5px] text-subtle">{p.code} · {p.hasVariants ? `${p.variantCount} хувилбар` : 'Үндсэн'}</span>
                <span className="flex items-center gap-2"><span className="text-[14.5px] font-extrabold">{money(p.price)}</span><StatusBadge status={p.status} label={p.statusLabel} /></span>
              </span>
            </Link>
            {canEdit ? <Link href={`/products/${p.id}?edit=1`} aria-label={`${p.code} засах`} className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-[11px] border border-line bg-surface px-3 text-[13px] font-semibold"><Icon name="edit" size={15} />Засах</Link> : null}
            </div>
            {p.variants.length ? (
              <>
                <button type="button" aria-expanded={!collapsed.has(p.id)} onClick={() => toggleOpen(p.id)} className="inline-flex h-9 w-fit items-center gap-1 rounded-lg px-1 text-[13px] font-semibold text-muted">
                  <Icon name={collapsed.has(p.id) ? 'right' : 'down'} size={14} /> {collapsed.has(p.id) ? 'Хувилбар харах' : 'Хувилбар хураах'}
                </button>
                {!collapsed.has(p.id) ? (
                  <ul className="ml-3 flex flex-col border-l-2 border-line pl-3">
                    {p.variants.map((v) => (
                      <li key={v.id} className={clsx('flex items-center gap-2.5 border-b border-line/60 py-2 last:border-0', !v.isActive && 'opacity-55')}>
                        <Thumb src={v.thumb} alt={v.label} size={34} />
                        <span className="flex min-w-0 flex-1 flex-col leading-tight">
                          <span className="truncate text-[14px] font-semibold">{v.label}</span>
                          <span className="truncate text-[11.5px] text-subtle">{v.code}{v.isActive ? '' : ' · Идэвхгүй'}</span>
                        </span>
                        <span className={clsx('text-[14px] font-bold', v.priceOverride && 'text-accent-ink')}>{money(v.price)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </li>
        ))}
      </ul>

      {!loading && data?.items.length === 0 ? <div className="rounded-[16px] border border-dashed border-line bg-surface p-8 text-center text-muted">Бараа олдсонгүй</div> : null}
      {loading && !data ? <p className="py-6 text-center text-muted">Ачаалж байна…</p> : null}

      {data && data.total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[13.5px] text-muted">
          <span>{(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} / {data.total.toLocaleString('en-US')}</span>
          <div className="flex gap-2">
            <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><Icon name="left" size={15} /> Өмнөх</Button>
            <Button size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Дараах <Icon name="right" size={15} /></Button>
          </div>
        </div>
      ) : null}

      <Modal open={bulkOpen} onClose={() => setBulkOpen(false)} title={`${selected.size} бараанд ангилал оноох`}
        footer={<><Button onClick={() => setBulkOpen(false)}>Болих</Button><Button variant="primary" onClick={() => setReasonOpen(true)}>Үргэлжлүүлэх</Button></>}>
        <Select id="bulk-cat" label="Ангилал" value={bulkCat} onChange={(e) => setBulkCat(e.target.value)}>
          <option value="">Ангилалгүй болгох</option>
          {cats.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Modal>
      <ReasonModal open={reasonOpen} busy={busy} onCancel={() => setReasonOpen(false)} onConfirm={bulkAssign}
        summary={<>{selected.size} барааны ангиллыг <strong>{cats.find((c) => String(c.id) === bulkCat)?.name ?? 'ангилалгүй'}</strong> болгоно.</>} />
    </div>
  );
}
