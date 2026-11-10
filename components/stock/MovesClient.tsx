'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';
import { ubDateTime } from '@/lib/format';

interface Move {
  id: string; at: string; type: string; typeLabel: string; qty: number; from: string | null; to: string | null;
  variantId: number; productId: number; code: string; name: string; label: string; thumb: string | null; docType: string; docId: number; note: string | null; actorName: string;
}
interface MovesResp { items: Move[]; page: number; hasMore: boolean }
interface Wh { id: number; name: string }
interface HistResp {
  product: { id: number; code: string; name: string; shelfCode: string | null };
  variants: { id: number; code: string; label: string; thumb: string | null }[];
  summary: { type: string; label: string; qty: number; count: number }[];
  whereNow: { locationId: number; name: string; kind: string; qty: number }[];
  history: MovesResp;
}

const TYPES = [
  { v: 'all', l: 'Бүх төрөл' }, { v: 'receipt', l: 'Орлого' }, { v: 'transfer', l: 'Шилжүүлэг' }, { v: 'issue', l: 'Зарлага' }, { v: 'count', l: 'Тооллого' }, { v: 'loan', l: 'Зээл' },
];
const KIND_LABEL: Record<string, string> = { WAREHOUSE: 'Агуулах', TRANSIT: 'Замдаа', STAFF: 'Ажилтны гарт', DRIVER: 'Жолоочийн гарт' };

function docHref(m: Move) {
  if (m.docType === 'transfer') return `/warehouse/transfers/${m.docId}`;
  if (m.docType === 'count') return `/warehouse/counts/${m.docId}`;
  if (m.docType === 'loan') return `/loans?id=${m.docId}`;
  return null;
}

/** Хөдөлгөөний түүх — productId өгвөл «Барааны түүх» (#39): нийлбэр, одоо хаана, бүх хөдөлгөөн */
export function MovesClient({ productId }: { productId?: number }) {
  const [type, setType] = useState('all');
  const [wh, setWh] = useState('');
  const [variantId, setVariantId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [whs, setWhs] = useState<Wh[]>([]);
  const [moves, setMoves] = useState<MovesResp | null>(null);
  const [hist, setHist] = useState<HistResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('variantId');
    if (v) setVariantId(v);
    api<{ items: Wh[] }>('/api/stock/warehouses?all=1').then((r) => setWhs(r.items)).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    const sp = new URLSearchParams({ page: String(page), type });
    if (wh) sp.set('warehouseId', wh);
    if (variantId) sp.set('variantId', variantId);
    if (from) sp.set('from', from);
    if (to) sp.set('to', to);
    try {
      if (productId) {
        const r = await api<HistResp>(`/api/stock/products/${productId}/history?${sp}`);
        if (id === reqId.current) { setHist(r); setMoves(r.history); setError(null); }
      } else {
        const r = await api<MovesResp>(`/api/stock/moves?${sp}`);
        if (id === reqId.current) { setMoves(r); setError(null); }
      }
    } catch (e) { if (id === reqId.current) setError(e instanceof ApiError ? e.message : 'Ачаалж чадсангүй'); }
  }, [productId, page, type, wh, variantId, from, to]);
  useEffect(() => { load(); }, [load]);

  const reset = (f: () => void) => { f(); setPage(1); };
  return (
    <div className="flex flex-col gap-4">
      {hist ? (
        <section className="flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[18px] font-extrabold">{hist.product.name}</span>
            <span className="text-[13px] text-subtle">{hist.product.code}{hist.product.shelfCode ? ` · Тавиур ${hist.product.shelfCode}` : ''}</span>
          </div>
          {hist.variants.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              <button type="button" aria-pressed={!variantId} onClick={() => reset(() => setVariantId(''))} className={clsx('h-9 rounded-full border px-3 text-[13px] font-semibold', !variantId ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>Бүх хувилбар</button>
              {hist.variants.map((v) => (
                <button key={v.id} type="button" aria-pressed={variantId === String(v.id)} onClick={() => reset(() => setVariantId(String(v.id)))}
                  className={clsx('h-9 rounded-full border px-3 text-[13px] font-semibold', variantId === String(v.id) ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>{v.label || v.code}</button>
              ))}
            </div>
          ) : null}
          <div>
            <h3 className="mb-1.5 text-[13px] font-bold text-muted">Одоо хаана байна</h3>
            <div className="flex flex-wrap gap-1.5">
              {hist.whereNow.length ? hist.whereNow.map((w) => <span key={w.locationId} className={clsx('rounded-lg px-2.5 py-1.5 text-[13px] font-semibold', w.kind === 'WAREHOUSE' ? 'bg-ok-soft text-ok-ink' : w.kind === 'TRANSIT' ? 'bg-info-soft text-info' : 'bg-surface2')}>{w.kind === 'WAREHOUSE' ? '' : `${KIND_LABEL[w.kind]}: `}{w.name}: {w.qty}</span>)
                : <span className="text-[13px] text-subtle">Үлдэгдэлгүй</span>}
            </div>
          </div>
          <div>
            <h3 className="mb-1.5 text-[13px] font-bold text-muted">Нийт хөдөлгөөн</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {hist.summary.map((s) => (
                <div key={s.type} className="rounded-xl bg-surface2 px-3 py-2">
                  <span className="block text-[18px] font-extrabold">{s.qty}</span>
                  <span className="text-[12px] text-muted">{s.label} · {s.count} удаа</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <select aria-label="Төрөл" value={type} onChange={(e) => reset(() => setType(e.target.value))} className="h-11 rounded-xl border border-line bg-surface px-3">{TYPES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}</select>
        <select aria-label="Агуулах" value={wh} onChange={(e) => reset(() => setWh(e.target.value))} className="h-11 rounded-xl border border-line bg-surface px-3"><option value="">Бүх агуулах</option>{whs.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-muted">Эхлэх<input type="date" value={from} onChange={(e) => reset(() => setFrom(e.target.value))} className="h-11 rounded-xl border border-line bg-surface px-2 text-ink" /></label>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-muted">Дуусах<input type="date" value={to} onChange={(e) => reset(() => setTo(e.target.value))} className="h-11 rounded-xl border border-line bg-surface px-2 text-ink" /></label>
      </div>
      {error ? <Notice>{error}</Notice> : null}

      <ul className="flex flex-col divide-y divide-line rounded-[18px] border border-line bg-surface shadow-card">
        {moves?.items.map((m) => {
          const href = docHref(m);
          return (
            <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
              {!productId ? <Thumb src={m.thumb} alt={`${m.name} ${m.label}`} size={38} zoom={m.code} /> : null}
              <span className="flex min-w-[180px] flex-1 flex-col">
                <span className="text-[14px] font-semibold">{m.typeLabel}{!productId ? <span className="font-normal text-muted"> · {m.name}{m.label ? ` · ${m.label}` : ''}</span> : m.label ? <span className="font-normal text-muted"> · {m.label}</span> : null}</span>
                <span className="text-[12.5px] text-subtle">{m.from ?? 'Гаднаас'} → {m.to ?? (m.type === 'ISSUE' ? 'Зарлага' : m.type === 'LOAN_CHARGE' ? 'Цалингийн суутгал' : 'Хасагдсан')}{m.note ? ` · ${m.note}` : ''}</span>
                <span className="text-[12px] text-subtle">{ubDateTime(m.at)} · {m.actorName}{href ? <> · <Link href={href} className="font-semibold text-accent-ink">Баримт №{m.docId}</Link></> : ` · №${m.docId}`}{!productId ? <> · <Link href={`/warehouse/products/${m.productId}?variantId=${m.variantId}`} className="font-semibold text-accent-ink">Түүх</Link></> : null}</span>
              </span>
              <span className={clsx('text-[18px] font-extrabold', m.to && !m.from ? 'text-ok-ink' : m.from && !m.to ? 'text-bad-ink' : 'text-ink')}>
                {m.to && !m.from ? `+${m.qty}` : m.from && !m.to ? `−${m.qty}` : m.qty}
              </span>
            </li>
          );
        })}
      </ul>
      {moves && !moves.items.length ? <div className="rounded-[16px] border border-dashed border-line bg-surface p-8 text-center text-muted">Хөдөлгөөн алга</div> : null}
      {moves && (page > 1 || moves.hasMore) ? (
        <div className="flex justify-end gap-2">
          <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><Icon name="left" size={15} /> Өмнөх</Button>
          <Button size="sm" disabled={!moves.hasMore} onClick={() => setPage((p) => p + 1)}>Дараах <Icon name="right" size={15} /></Button>
        </div>
      ) : null}
    </div>
  );
}
