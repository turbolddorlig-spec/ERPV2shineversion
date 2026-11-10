'use client';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/icons';
import { api } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';

/** Баримтын нэг мөр */
export interface PickLine { variantId: number; qty: number; code: string; name: string; label: string; thumb: string | null; shelfCode?: string | null }

interface Hit { variantId: number; variantCode: string; name: string; label: string; fullName: string; thumb: string | null; discontinued: boolean }
export interface StockRow { variantId: number; code: string; name: string; label: string; thumb: string | null; shelfCode: string | null; byWarehouse: Record<string, number>; total: number }

/** Мөрүүдийн одоогийн үлдэгдлийг авах (агуулах тус бүрээр) */
export async function fetchStockRows(ids: number[]): Promise<Map<number, StockRow>> {
  if (!ids.length) return new Map();
  const r = await api<{ items: StockRow[] }>(`/api/stock?ids=${ids.join(',')}`);
  return new Map(r.items.map((i) => [i.variantId, i]));
}

/** URL-ийн ?lines=12:5,13:2 → мөрүүд (дүүргэлт, үлдэгдлийн мөрөөс нэг товчоор ирэхэд) */
export async function linesFromQuery(param: string | null): Promise<PickLine[]> {
  const pairs = (param ?? '').split(',').map((p) => p.split(':').map(Number)).filter(([v, q]) => Number.isInteger(v) && v! > 0 && Number.isInteger(q) && q! > 0) as [number, number][];
  if (!pairs.length) return [];
  const rows = await fetchStockRows(pairs.map(([v]) => v));
  return pairs.filter(([v]) => rows.has(v)).map(([v, q]) => { const r = rows.get(v)!; return { variantId: v, qty: q, code: r.code, name: r.name, label: r.label, thumb: r.thumb, shelfCode: r.shelfCode }; });
}

/**
 * Нэг хайлт хаа сайгүй (#39): код, нэр, өнгө, хэмжээгээр хайж мөр нэмнэ. Зурагтай, том товчтой (iPad, утсанд).
 * stockWarehouseId өгвөл мөр бүрт тухайн агуулахад «байгаа» тоог харуулна.
 */
export function ItemPicker({ lines, onChange, stockWarehouseId, qtyLabel = 'Тоо', autoFocus }: {
  lines: PickLine[]; onChange: (l: PickLine[]) => void; stockWarehouseId?: number | null; qtyLabel?: string; autoFocus?: boolean;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [have, setHave] = useState<Map<number, StockRow>>(new Map());
  const req = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 1) { setHits([]); return; }
    const id = ++req.current;
    setBusy(true);
    const t = setTimeout(() => {
      api<{ items: Hit[] }>(`/api/products/search?q=${encodeURIComponent(term)}&limit=12`)
        .then((r) => { if (id === req.current) { setHits(r.items); setOpen(true); } })
        .catch(() => undefined).finally(() => { if (id === req.current) setBusy(false); });
    }, 220);
    return () => clearTimeout(t);
  }, [q]);

  const idsKey = lines.map((l) => l.variantId).sort((a, b) => a - b).join(',');
  useEffect(() => {
    if (!stockWarehouseId || !idsKey) { setHave(new Map()); return; }
    fetchStockRows(idsKey.split(',').map(Number)).then(setHave).catch(() => undefined);
  }, [idsKey, stockWarehouseId]);

  function add(h: Hit) {
    const ex = lines.find((l) => l.variantId === h.variantId);
    onChange(ex ? lines.map((l) => (l.variantId === h.variantId ? { ...l, qty: l.qty + 1 } : l))
      : [...lines, { variantId: h.variantId, qty: 1, code: h.variantCode, name: h.name, label: h.label === 'Үндсэн' ? '' : h.label, thumb: h.thumb }]);
    setQ(''); setHits([]); setOpen(false);
    inputRef.current?.focus();
  }
  const setQty = (id: number, qty: number) => onChange(lines.map((l) => (l.variantId === id ? { ...l, qty: Math.max(0, Math.min(100000, qty)) } : l)));

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <label htmlFor="pick-q" className="sr-only">Бараа хайх</label>
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle"><Icon name="search" size={18} /></span>
        <input id="pick-q" ref={inputRef} autoFocus={autoFocus} value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => hits.length && setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) { e.preventDefault(); add(hits[0]); } if (e.key === 'Escape') setOpen(false); }}
          placeholder="Код, нэр, өнгө, хэмжээгээр хайх…" autoComplete="off"
          className="h-12 w-full rounded-xl border border-line bg-surface py-3 pl-11 pr-3 text-[15px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft" />
        {open && q.trim() ? (
          <ul role="listbox" className="absolute inset-x-0 top-full z-30 mt-1 max-h-[60vh] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-pop">
            {hits.length === 0 ? <li className="px-3 py-3 text-[14px] text-muted">{busy ? 'Хайж байна…' : 'Олдсонгүй'}</li> : hits.map((h) => (
              <li key={h.variantId}>
                <button type="button" role="option" aria-selected="false" onClick={() => add(h)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface2">
                  <Thumb src={h.thumb} alt={h.fullName} size={44} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[14.5px] font-semibold">{h.fullName}</span>
                    <span className="text-[12px] text-subtle">{h.variantCode}{h.discontinued ? ' · Зогсоосон' : ''}</span>
                  </span>
                  <Icon name="plus" size={18} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {lines.length ? (
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
          {lines.map((l) => {
            const avail = stockWarehouseId ? have.get(l.variantId)?.byWarehouse[String(stockWarehouseId)] ?? 0 : null;
            const over = avail !== null && l.qty > avail;
            return (
              <li key={l.variantId} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <Thumb src={l.thumb} alt={`${l.name} ${l.label}`} size={44} zoom={l.code} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[14.5px] font-semibold">{l.name}{l.label ? <span className="text-muted"> · {l.label}</span> : null}</span>
                  <span className="text-[12px] text-subtle">{l.code}{avail !== null ? <> · <span className={clsx(over && 'font-bold text-bad-ink')}>Байгаа: {avail}</span></> : null}</span>
                </span>
                <span className="flex items-center gap-1" aria-label={qtyLabel}>
                  <button type="button" aria-label="Хасах" onClick={() => setQty(l.variantId, l.qty - 1)} className="grid h-11 w-11 place-items-center rounded-lg border border-line bg-surface text-[20px] font-bold">−</button>
                  <input aria-label={`${l.code} ${qtyLabel.toLowerCase()}`} inputMode="numeric" value={l.qty} onChange={(e) => setQty(l.variantId, Number(e.target.value.replace(/[^\d]/g, '')) || 0)}
                    className={clsx('h-11 w-20 rounded-lg border bg-surface text-center text-[16px] font-bold outline-none focus:border-accent', over ? 'border-bad' : 'border-line')} />
                  <button type="button" aria-label="Нэмэх" onClick={() => setQty(l.variantId, l.qty + 1)} className="grid h-11 w-11 place-items-center rounded-lg border border-line bg-surface text-[20px] font-bold">+</button>
                </span>
                <button type="button" aria-label={`${l.code} мөр хасах`} onClick={() => onChange(lines.filter((x) => x.variantId !== l.variantId))} className="grid h-11 w-11 place-items-center rounded-lg text-bad-ink hover:bg-bad-soft"><Icon name="trash" size={17} /></button>
              </li>
            );
          })}
        </ul>
      ) : <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[14px] text-muted">Дээрх хайлтаар бараа нэмнэ үү</p>}
      {lines.length ? <p className="text-right text-[13px] font-semibold text-muted">{lines.length} бараа · нийт {lines.reduce((s, l) => s + l.qty, 0)} ширхэг</p> : null}
    </div>
  );
}

/** Давхар дарахаас хамгаалах түлхүүр — маягт нээгдэхэд нэг удаа */
export function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
