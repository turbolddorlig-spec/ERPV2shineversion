'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ImageGroups, type ImageOp, type PendingImage } from './ImageGroups';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { ChipsInput } from '@/components/ui/ChipsInput';
import { Notice } from '@/components/ui/Notice';
import { ReasonModal } from '@/components/ui/ReasonModal';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { money } from '@/lib/format';
import { StatusBadge } from './ProductsClient';
import { ProductHistoryList } from './ProductHistoryList';

export interface Variant { id: number; code: string; color: string; size: string; label: string; priceOverride: number | null; price: number; isActive: boolean }
export interface Img { id: string; color: string; isMain: boolean; sm: string; md: string; lg: string }
export interface Product {
  id: number; code: string; name: string; description: string | null; price: number; costPrice?: number | null;
  status: 'ACTIVE' | 'DISCONTINUED' | 'ARCHIVED'; statusLabel: string; statusNote: string | null;
  category: { id: number; name: string } | null; season: { id: number; name: string } | null;
  colors: string[]; sizes: string[]; version: number; variants: Variant[]; images: Img[];
}
interface Perms { edit: boolean; cost: boolean; code: boolean; status: boolean }
interface Opt { id: number; name: string; isActive: boolean }

const STATUS_OPTS = [
  { v: 'ACTIVE', l: 'Идэвхтэй', d: 'Зарна' },
  { v: 'DISCONTINUED', l: 'Зогсоосон', d: 'Дахин захиалахгүй, үлдсэнийг зарна' },
  { v: 'ARCHIVED', l: 'Архив', d: 'Зарахгүй, жагсаалтаас нуугдана' },
] as const;

const key = (c: string, s: string) => `${c.toLowerCase()}\u0000${s.toLowerCase()}`;

export function ProductEditor({ product: initial, perms }: { product: Product | null; perms: Perms }) {
  const router = useRouter();
  const isNew = !initial;
  const [product, setProduct] = useState<Product | null>(initial);
  const [cats, setCats] = useState<Opt[]>([]);
  const [seasons, setSeasons] = useState<Opt[]>([]);

  // Маягтын төлөв
  const [code, setCode] = useState(initial?.code ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [categoryId, setCategoryId] = useState(initial?.category ? String(initial.category.id) : '');
  const [seasonId, setSeasonId] = useState(initial?.season ? String(initial.season.id) : '');
  const [price, setPrice] = useState(initial ? String(initial.price) : '');
  const [cost, setCost] = useState(initial?.costPrice != null ? String(initial.costPrice) : '');
  const [colors, setColors] = useState<string[]>(initial?.colors ?? []);
  const [sizes, setSizes] = useState<string[]>(initial?.sizes ?? []);
  const [vPatch, setVPatch] = useState<Record<number, { priceOverride?: string; isActive?: boolean }>>({});

  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reasonFor, setReasonFor] = useState<null | 'save' | 'status' | { img: Img; op: 'delete' | 'main' | 'up' | 'down' | 'color'; color?: string }>(null);
  const [reasonErr, setReasonErr] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [statusTo, setStatusTo] = useState<Product['status'] | null>(null);
  // Сонгосон (хадгалаагүй) зураг — өнгө тус бүртэй
  const [pending, setPending] = useState<PendingImage[]>([]);
  const productColors = product?.colors;
  const uploadColors = useMemo(() => (isNew ? colors : (productColors ?? [])), [isNew, colors, productColors]);
  const pendingRef = useRef<PendingImage[]>([]);
  pendingRef.current = pending;
  useEffect(() => () => pendingRef.current.forEach((p) => URL.revokeObjectURL(p.url)), []);
  // Өнгө хасагдвал түүний сонгосон зураг «Ерөнхий» рүү шилжинэ
  useEffect(() => {
    setPending((ps) => (ps.some((p) => p.color && !uploadColors.includes(p.color)) ? ps.map((p) => (p.color && !uploadColors.includes(p.color) ? { ...p, color: '' } : p)) : ps));
  }, [uploadColors]);
  function addPending(color: string, files: File[]) {
    setPending((ps) => [...ps, ...files.map((file) => ({ id: `${Date.now()}-${Math.random()}`, file, color, url: URL.createObjectURL(file) }))]);
  }
  function removePending(id: string) {
    setPending((ps) => { const x = ps.find((p) => p.id === id); if (x) URL.revokeObjectURL(x.url); return ps.filter((p) => p.id !== id); });
  }
  const [historyKey, setHistoryKey] = useState(0);
  const ro = !perms.edit;

  useEffect(() => {
    api<{ items: Opt[] }>('/api/catalog/categories').then((r) => setCats(r.items)).catch(() => undefined);
    api<{ items: Opt[] }>('/api/catalog/seasons').then((r) => setSeasons(r.items)).catch(() => undefined);
    if (isNew && perms.edit) api<{ code: string }>('/api/products/next-code').then((r) => setCode((c) => c || r.code)).catch(() => undefined);
  }, [isNew, perms.edit]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 4000); return () => clearTimeout(t); }, [flash]);

  function resetFrom(p: Product) {
    setProduct(p); setCode(p.code); setName(p.name); setDescription(p.description ?? '');
    setCategoryId(p.category ? String(p.category.id) : ''); setSeasonId(p.season ? String(p.season.id) : '');
    setPrice(String(p.price)); setCost(p.costPrice != null ? String(p.costPrice) : '');
    setColors(p.colors); setSizes(p.sizes); setVPatch({}); setHistoryKey((k) => k + 1);
  }

  // Хадгалахаас өмнө ямар хувилбар үүсэх/идэвхгүй болохыг урьдчилан харуулна
  const preview = useMemo(() => {
    const cs = colors.length ? colors : [''];
    const ss = sizes.length ? sizes : [''];
    const wanted = cs.flatMap((c) => ss.map((s) => ({ color: c, size: s })));
    const existing = product?.variants ?? [];
    const rows = wanted.map((w) => {
      const v = existing.find((e) => key(e.color, e.size) === key(w.color, w.size));
      return { ...w, variant: v ?? null, isNew: !v };
    });
    const removed = existing.filter((e) => !wanted.some((w) => key(w.color, w.size) === key(e.color, e.size)) && e.isActive);
    return { rows, removed };
  }, [colors, sizes, product]);

  const changes = useMemo(() => {
    if (!product) return null;
    const c: Record<string, unknown> = {};
    if (code.trim().toUpperCase() !== product.code) c.code = code;
    if (name.trim() !== product.name) c.name = name;
    if ((description.trim() || null) !== (product.description ?? null)) c.description = description;
    if ((categoryId || '') !== (product.category ? String(product.category.id) : '')) c.categoryId = categoryId || null;
    if ((seasonId || '') !== (product.season ? String(product.season.id) : '')) c.seasonId = seasonId || null;
    if (Number(price) !== product.price) c.price = price;
    if (perms.cost && (cost === '' ? null : Number(cost)) !== (product.costPrice ?? null)) c.costPrice = cost === '' ? null : cost;
    if (colors.join('|') !== product.colors.join('|')) c.colors = colors;
    if (sizes.join('|') !== product.sizes.join('|')) c.sizes = sizes;
    const vs = Object.entries(vPatch).map(([id, p]) => {
      const v = product.variants.find((x) => x.id === Number(id))!;
      const out: Record<string, unknown> = { id: Number(id) };
      if (p.priceOverride !== undefined && (p.priceOverride === '' ? null : Number(p.priceOverride)) !== v.priceOverride) out.priceOverride = p.priceOverride === '' ? null : p.priceOverride;
      if (p.isActive !== undefined && p.isActive !== v.isActive) out.isActive = p.isActive;
      return out;
    }).filter((o) => Object.keys(o).length > 1);
    if (vs.length) c.variants = vs;
    return c;
  }, [product, code, name, description, categoryId, seasonId, price, cost, colors, sizes, vPatch, perms.cost]);
  const dirty = isNew ? true : !!changes && Object.keys(changes).length > 0;

  async function create() {
    setError(null); setSaving(true);
    try {
      const r = await api<{ product: Product }>('/api/products', { method: 'POST', json: {
        code, name, description, categoryId: categoryId || null, seasonId: seasonId || null, price,
        ...(cost !== '' ? { costPrice: cost } : {}), colors, sizes,
      } });
      if (pending.length) {
        const fails = await uploadFiles('Бараа бүртгэхэд оруулсан зураг', r.product.id);
        if (fails.length) {
          // Бараа үүссэн ч зарим зураг орсонгүй → барааны хуудсанд үлдэж, дахин оруулна
          router.replace(`/products/${r.product.id}?edit=1&imgfail=${encodeURIComponent(fails.join(' · '))}`);
          router.refresh();
          return;
        }
      }
      router.push('/products');
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Хадгалж чадсангүй');
      setSaving(false);
    }
  }

  /** Хадгалах: талбарын өөрчлөлт (байвал) + сонгосон зураг (байвал) → амжилттай бол барааны жагсаалт руу буцна */
  async function saveWithReason(reason: string) {
    if (!product) return;
    const inModal = reasonFor !== null;
    setSaving(true); setReasonErr(null);
    try {
      if (changes && Object.keys(changes).length) {
        const r = await api<{ product: Product; changed: boolean }>(`/api/products/${product.id}`, { method: 'PATCH', json: { changes, reason, version: product.version } });
        resetFrom(r.product);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'stale') { setStale(true); setReasonFor(null); }
      else if (inModal) setReasonErr(e instanceof ApiError ? e.message : 'Хадгалж чадсангүй');
      else setError(e instanceof ApiError ? e.message : 'Хадгалж чадсангүй');
      setSaving(false);
      return;
    }
    if (pending.length) {
      const fails = await uploadFiles(reason);
      if (fails.length) {
        setSaving(false); setReasonFor(null); await reloadProduct();
        setError(`Өөрчлөлт хадгалагдсан ч зарим зураг орсонгүй: ${fails.join(' · ')}`);
        return;
      }
    }
    router.push('/products');
    router.refresh();
  }

  /** Хадгалах товч: өөрчлөлт эсвэл сонгосон зураг байвал тайлбар асууна, юу ч өөрчлөөгүй бол шууд жагсаалт руу буцна */
  function onSaveClick() {
    if (isNew) return void create();
    // Зөвхөн өртөг өөрчилсөн бол (зөвхөн СА/А) тайлбар асуухгүй (#32)
    if (dirty && !pending.length && changes && Object.keys(changes).every((k) => k === 'costPrice')) { setError(null); return void saveWithReason(''); }
    if (dirty || pending.length) { setReasonErr(null); setReasonFor('save'); return; }
    router.push('/products');
    router.refresh();
  }

  async function changeStatus(reason: string) {
    if (!product || !statusTo) return;
    setSaving(true); setReasonErr(null);
    try {
      const r = await api<{ product: Product }>(`/api/products/${product.id}/status`, { method: 'POST', json: { status: statusTo, reason, version: product.version } });
      resetFrom(r.product); setReasonFor(null); setStatusTo(null); setFlash(`Төлөв: ${r.product.statusLabel}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'stale') { setStale(true); setReasonFor(null); }
      else setReasonErr(e instanceof ApiError ? e.message : 'Алдаа гарлаа');
    } finally { setSaving(false); }
  }

  async function reloadProduct() {
    if (!product) return;
    const r = await api<{ product: Product }>(`/api/products/${product.id}`);
    resetFrom(r.product);
  }

  /** Сонгосон зургуудыг (ерөнхий эхлээд, дараа нь өнгө тус бүр) оруулна. Буцаах утга: орж чадаагүй зургийн алдаа */
  async function uploadFiles(reason: string, pid = product?.id): Promise<string[]> {
    if (!pid) return [];
    const fails: string[] = [];
    const order = ['', ...uploadColors];
    const list = [...pending].sort((a, b) => order.indexOf(a.color) - order.indexOf(b.color));
    for (const p of list) {
      const fd = new FormData();
      fd.set('file', p.file); fd.set('reason', reason); fd.set('color', p.color);
      const res = await fetch(`/api/products/${pid}/images`, { method: 'POST', body: fd });
      if (!res.ok) fails.push(`${p.file.name}: ${(await res.json().catch(() => ({}))).error ?? 'алдаа'}`);
    }
    pending.forEach((p) => URL.revokeObjectURL(p.url));
    setPending([]);
    return fails;
  }

  async function imageOp(reason: string) {
    if (!reasonFor || typeof reasonFor !== 'object') return;
    const { img, op, color } = reasonFor;
    setSaving(true); setReasonErr(null);
    try {
      if (op === 'delete') await api(`/api/products/images/${img.id}`, { method: 'DELETE', json: { reason } });
      else await api(`/api/products/images/${img.id}`, { method: 'PATCH', json: {
        reason, ...(op === 'main' ? { isMain: true } : {}), ...(op === 'up' || op === 'down' ? { move: op } : {}), ...(op === 'color' ? { color } : {}),
      } });
      setReasonFor(null); await reloadProduct();
    } catch (e) {
      setReasonErr(e instanceof ApiError ? e.message : 'Алдаа гарлаа');
    } finally { setSaving(false); }
  }

  const changeSummary = (changes && Object.keys(changes).length) || pending.length ? (
    <ul className="list-disc pl-5">
      {pending.length ? <li>{pending.length} шинэ зураг нэмнэ</li> : null}
      {changes && 'code' in changes ? <li>Код: {product?.code} → {String(changes.code).toUpperCase()}</li> : null}
      {changes && ('name' in changes) ? <li>Нэр: {product?.name} → {String(changes.name)}</li> : null}
      {changes && ('price' in changes) ? <li><strong>Үнэ: {money(product?.price)} → {money(Number(changes.price))}</strong></li> : null}
      {changes && ('costPrice' in changes) ? <li>Өртөг: {money(product?.costPrice)} → {money(changes.costPrice === null ? null : Number(changes.costPrice))}</li> : null}
      {changes && ('categoryId' in changes) ? <li>Ангилал</li> : null}
      {changes && ('seasonId' in changes) ? <li>Улирал</li> : null}
      {changes && ('description' in changes) ? <li>Тайлбар</li> : null}
      {changes && ('colors' in changes || 'sizes' in changes) ? <li>Өнгө / хэмжээ</li> : null}
      {changes && ('variants' in changes) ? <li>Хувилбарын үнэ / идэвх</li> : null}
    </ul>
  ) : null;

  const imgFail = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('imgfail') : null;

  return (
    <div className="flex flex-col gap-5 pb-24">
      {imgFail ? <Notice>Бараа үүслээ, гэхдээ зарим зураг орсонгүй: {imgFail}. Зургаа дахин сонгоод «Хадгалах» дарна уу.</Notice> : null}
      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}
      {stale ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warn-soft px-3.5 py-3 text-[13.5px] font-medium text-warn">
          Энэ барааг өөр хүн дөнгөж сая засчихсан байна. Таны өөрчлөлт хадгалагдаагүй.
          <Button size="sm" onClick={async () => { await reloadProduct(); setStale(false); }}>Шинэчилж ачаалах</Button>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="flex flex-col gap-4 rounded-[18px] border border-line bg-surface p-5 shadow-card">
            <h2 className="text-[16px] font-extrabold">Үндсэн мэдээлэл</h2>
            <div className="grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
              <Field id="p-code" label="Код" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
                disabled={ro || (!isNew && !perms.code)} maxLength={40}
                hint={isNew ? 'Дараагийн чөлөөт кодыг санал болгов' : !perms.code ? 'Кодыг зөвхөн админ солино' : undefined} />
              <Field id="p-name" label="Нэр" value={name} onChange={(e) => setName(e.target.value)} disabled={ro} maxLength={150} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="p-desc" className="text-[13px] font-semibold text-muted">Тайлбар</label>
              <textarea id="p-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} disabled={ro} maxLength={3000}
                className="rounded-xl border border-line bg-surface px-3.5 py-3 text-ink outline-none focus:border-accent disabled:opacity-60" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Select id="p-cat" label="Ангилал" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={ro}>
                <option value="">— Сонгоогүй —</option>
                {cats.filter((c) => c.isActive || String(c.id) === categoryId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
              <Select id="p-season" label="Улирал" value={seasonId} onChange={(e) => setSeasonId(e.target.value)} disabled={ro}>
                <option value="">— Сонгоогүй —</option>
                {seasons.filter((c) => c.isActive || String(c.id) === seasonId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>
          </section>

          <section className="flex flex-col gap-4 rounded-[18px] border border-line bg-surface p-5 shadow-card">
            <h2 className="text-[16px] font-extrabold">Үнэ</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="p-price" label="Зарах үнэ (₮)" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ''))} disabled={ro}
                hint={price ? money(Number(price)) : undefined} />
              {perms.cost || isNew ? (
                <Field id="p-cost" label={isNew && !perms.cost ? 'Өртөг (₮) — дараа нь зөвхөн админ харж, засна' : 'Өртөг (₮) — зөвхөн админд харагдана'} inputMode="numeric" value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d]/g, ''))} disabled={ro}
                  hint={cost && price ? `Ашиг: ${money(Number(price) - Number(cost))}` : undefined} />
              ) : null}
            </div>
          </section>

          <section className="flex flex-col gap-4 rounded-[18px] border border-line bg-surface p-5 shadow-card">
            <div>
              <h2 className="text-[16px] font-extrabold">Хувилбар (өнгө / хэмжээ)</h2>
              <p className="text-[13px] text-muted">Ганц өнгө, ганц хэмжээтэй бол (жишээ: Улаан, 38см) энгийн бараа хэвээр — жагсаалт, захиалгад нэг мөр болж харагдана. Олон өнгө эсвэл олон хэмжээтэй бол хувилбар бүр тусдаа үнэ, үлдэгдэлтэй.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <ChipsInput id="p-colors" label="Өнгө" values={colors} onChange={setColors} placeholder="Хар, Цагаан…" disabled={ro} />
              <ChipsInput id="p-sizes" label="Хэмжээ" values={sizes} onChange={setSizes} placeholder="37, 38, 39…" disabled={ro} />
            </div>
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full min-w-[520px] border-collapse text-[13.5px]">
                <thead>
                  <tr className="bg-surface2 text-left text-[12px] text-muted">
                    <th scope="col" className="border-b border-line px-3 py-2 font-bold">Хувилбар</th>
                    <th scope="col" className="border-b border-line px-3 py-2 font-bold">Код</th>
                    <th scope="col" className="border-b border-line px-3 py-2 font-bold">Өөр үнэ (хоосон = {money(Number(price) || 0)})</th>
                    <th scope="col" className="border-b border-line px-3 py-2 font-bold">Идэвхтэй</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => {
                    const v = r.variant;
                    const p = v ? vPatch[v.id] : undefined;
                    const label = [r.color, r.size].filter(Boolean).join(' · ') || 'Үндсэн';
                    return (
                      <tr key={key(r.color, r.size)}>
                        <td className="border-b border-line px-3 py-2 font-semibold">{label}{r.isNew ? <span className="ml-2 rounded-md bg-ok-soft px-1.5 py-0.5 text-[11px] font-bold text-ok-ink">шинэ</span> : null}</td>
                        <td className="border-b border-line px-3 py-2 text-muted">{v?.code ?? 'хадгалахад үүснэ'}</td>
                        <td className="border-b border-line px-3 py-2">
                          {v && !isNew ? (
                            <input aria-label={`${label} өөр үнэ`} inputMode="numeric" disabled={ro}
                              value={p?.priceOverride ?? (v.priceOverride != null ? String(v.priceOverride) : '')}
                              onChange={(e) => setVPatch((s) => ({ ...s, [v.id]: { ...s[v.id], priceOverride: e.target.value.replace(/[^\d]/g, '') } }))}
                              className="h-10 w-36 rounded-lg border border-line bg-surface px-2.5 text-ink outline-none focus:border-accent disabled:opacity-60" placeholder="—" />
                          ) : <span className="text-subtle">—</span>}
                        </td>
                        <td className="border-b border-line px-3 py-2">
                          {v && !isNew ? (
                            <input type="checkbox" aria-label={`${label} идэвхтэй`} disabled={ro} className="h-5 w-5 accent-[var(--accent)]"
                              checked={p?.isActive ?? v.isActive}
                              onChange={(e) => setVPatch((s) => ({ ...s, [v.id]: { ...s[v.id], isActive: e.target.checked } }))} />
                          ) : <span className="text-ok-ink">✓</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {preview.removed.map((v) => (
                    <tr key={v.id} className="opacity-60">
                      <td className="border-b border-line px-3 py-2 line-through">{v.label}</td>
                      <td className="border-b border-line px-3 py-2 text-muted">{v.code}</td>
                      <td colSpan={2} className="border-b border-line px-3 py-2 text-[12.5px] text-warn">Идэвхгүй болно (устгахгүй — түүх хадгалагдана)</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {!isNew && product ? (
            <section className="flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-5 shadow-card">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[16px] font-extrabold">Төлөв</h2>
                <StatusBadge status={product.status} label={product.statusLabel} />
              </div>
              {product.statusNote && product.status !== 'ACTIVE' ? <p className="text-[13px] text-muted">Шалтгаан: {product.statusNote}</p> : null}
              {perms.status && perms.edit ? (
                <div className="flex flex-col gap-2">
                  {STATUS_OPTS.filter((s) => s.v !== product.status).map((s) => (
                    <button key={s.v} type="button" onClick={() => { setStatusTo(s.v); setReasonFor('status'); }}
                      className="flex w-full flex-col items-start gap-0.5 rounded-[11px] border border-line bg-surface px-3.5 py-2.5 text-left hover:bg-surface2">
                      <span className="text-[14px] font-semibold">{s.l} болгох</span>
                      <span className="text-[12.5px] leading-snug text-subtle">{s.d}</span>
                    </button>
                  ))}
                </div>
              ) : <p className="text-[12.5px] text-subtle">Төлөвийг Супер админ, Админ, Ахлах маркетинг солино.</p>}
            </section>
          ) : null}

          <section className="flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-5 shadow-card">
            <h2 className="text-[16px] font-extrabold">Зураг</h2>
            <ImageGroups colors={uploadColors} images={product?.images ?? []} pending={pending} canEdit={perms.edit}
              productName={name || product?.name || 'Бараа'} onAdd={addPending} onRemovePending={removePending}
              onOp={(img, op: ImageOp, color) => {
                if (op === 'color' && color === img.color) return;
                setReasonErr(null); setReasonFor({ img, op, color });
              }} />
          </section>

          {!isNew && product ? (
            <section className="flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-5 shadow-card">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[16px] font-extrabold">Түүх</h2>
                <Link href={`/products/history?productId=${product.id}`} className="text-[13px] font-semibold text-accent-ink">Бүгдийг харах</Link>
              </div>
              <ProductHistoryList key={historyKey} productId={product.id} compact />
            </section>
          ) : null}
        </div>
      </div>

      {perms.edit ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:left-[84px]">
          <div className="mx-auto flex max-w-[1400px] items-center justify-end gap-2">
            {!isNew && (dirty || pending.length) ? <span className="mr-auto text-[13px] font-semibold text-warn">Хадгалаагүй өөрчлөлт байна</span> : null}
            <Link href="/products" className="inline-flex h-11 items-center rounded-[11px] border border-line bg-surface px-4 font-semibold">Буцах</Link>
            <Button variant="primary" size="lg" loading={saving && !reasonFor} disabled={saving}
              onClick={onSaveClick}>
              {isNew ? 'Бараа үүсгэх' : 'Хадгалах'}
            </Button>
          </div>
        </div>
      ) : null}

      <ReasonModal open={reasonFor === 'save'} busy={saving} error={reasonErr} summary={changeSummary}
        onCancel={() => setReasonFor(null)} onConfirm={saveWithReason} />
      <ReasonModal open={reasonFor === 'status'} busy={saving} error={reasonErr} title="Төлөв солих шалтгаан"
        summary={<>Төлөв: <strong>{product?.statusLabel}</strong> → <strong>{STATUS_OPTS.find((s) => s.v === statusTo)?.l}</strong></>}
        onCancel={() => { setReasonFor(null); setStatusTo(null); }} onConfirm={changeStatus} />
      <ReasonModal open={!!reasonFor && typeof reasonFor === 'object'} busy={saving} error={reasonErr} title="Зургийн өөрчлөлтийн тайлбар"
        summary={reasonFor && typeof reasonFor === 'object' ? ({ delete: 'Зураг хасна', main: 'Үндсэн зураг болгоно', up: 'Урагш зөөнө', down: 'Хойш зөөнө', color: `Өнгө: ${reasonFor.color || 'Ерөнхий'}` }[reasonFor.op]) : null}
        onCancel={() => setReasonFor(null)} onConfirm={imageOp} />
    </div>
  );
}
