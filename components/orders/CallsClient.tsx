'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { ubDateTime } from '@/lib/format';
import { formatPhone } from '@/lib/phone';
import type { OrderPrefill } from './OrderForm';

interface Note {
  id: number; phone: string; note: string | null; status: string; statusLabel: string; ownerId: string; ownerName: string; attempts: number;
  lastAttemptAt: string | null; canAttemptAt: string | null; variantId: number | null; product: string | null; productCode: string | null; thumb: string | null;
  pageId: number | null; pageName: string | null; orderId: number | null; orderNumber: string | null; pendingTransferTo: string | null;
  closeLabel: string | null; closeNote: string | null; createdAt: string;
}
interface Resp {
  total: number; page: number; pageSize: number; supervise: boolean; scope: 'own' | 'all'; counts: Record<string, number>;
  items: Note[]; incoming: { transferId: number; fromName: string; createdAt: string; note: Note }[];
}
interface Hit { variantId: number; variantCode: string; fullName: string; available: number }

/** Хуучин ERP-ийн табууд */
const TABS = [
  { v: 'PENDING', l: 'Залгаагүй', icon: '📵' }, { v: 'CONTACTED', l: 'Залгасан', icon: '📞' }, { v: 'incoming', l: 'Шилжиж ирсэн', icon: '📥' },
  { v: 'ORDERED', l: 'Захиалга үүссэн', icon: '✅' }, { v: 'CANCELLED', l: 'Цуцласан', icon: '⛔' },
] as const;
const CLOSE = [
  { v: 'NO_ANSWER', l: 'Утсаа аваагүй' }, { v: 'PRICE', l: 'Үнэ үнэтэй' }, { v: 'OUT_OF_STOCK', l: 'Бараа дууссан' }, { v: 'NO_SIZE_COLOR', l: 'Өнгө, хэмжээ байхгүй' },
  { v: 'DELIVERY', l: 'Хүргэлт' }, { v: 'JUST_ASKING', l: 'Зүгээр асуусан' }, { v: 'BOUGHT_ELSEWHERE', l: 'Өөр газраас авсан' }, { v: 'OTHER', l: 'Бусад' },
];
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const inp = 'h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-accent';
const sbtn = 'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-semibold';

/**
 * Дуудлагын бүртгэл — хуучин ERP шиг цонх (Sticky Notes):
 * дээр нь нэмэх хэсэг (Бараа · Утас (Enter → дараагийн мөр) · Пэйж · Бүртгэх), дараа нь шүүлт, табууд;
 * мөр бүрт 1–5 «Залгасан» нүд (30 мин зайтай), «Захиалга», «Шилжүүлэх», «Цуцлах» (шалтгаантай, #54).
 */
export function CallsModal({ open, onClose, onCreateOrder }: { open: boolean; onClose: () => void; onCreateOrder: (p: OrderPrefill) => void }) {
  return (
    <Modal open={open} onClose={onClose} size="xl" title="📒 Дуудлагын бүртгэл"
      subtitle="Пэйж шүүхдээ дугаар + бараа + пэйж бүртгээд, захиалга үүсгэхэд автоматаар тэмдэглэгдэнэ" bodyClassName="min-h-0 flex-1 overflow-y-auto">
      {open ? <CallsBody onCreateOrder={onCreateOrder} /> : null}
    </Modal>
  );
}

function CallsBody({ onCreateOrder }: { onCreateOrder: (p: OrderPrefill) => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]['v']>('PENDING');
  const [scope, setScope] = useState<'own' | 'all'>('own');
  const [owner, setOwner] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Resp | null>(null);
  const [ops, setOps] = useState<{ id: string; name: string }[]>([]);
  const [pages, setPages] = useState<{ id: number; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [closing, setClosing] = useState<Note | null>(null);
  const [transferring, setTransferring] = useState<number | null>(null);
  const [target, setTarget] = useState('');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [bulkTo, setBulkTo] = useState('');
  const req = useRef(0);

  const load = useCallback(() => {
    const id = ++req.current;
    const sp = new URLSearchParams({ status: tab === 'incoming' ? 'open' : tab, page: String(page), scope });
    if (q.trim()) sp.set('q', q.trim());
    if (scope === 'all' && owner) sp.set('ownerId', owner);
    return api<Resp>(`/api/calls?${sp}`).then((r) => { if (id === req.current) { setData(r); setError(null); } }).catch((e) => setError(msg(e)));
  }, [tab, page, q, scope, owner]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => {
    api<{ items: { id: string; name: string }[] }>('/api/calls/operators').then((r) => setOps(r.items)).catch(() => undefined);
    api<{ pages: { id: number; name: string }[] }>('/api/orders/pages').then((r) => setPages(r.pages)).catch(() => undefined);
  }, []);
  // 30 минутын хаалтыг дэлгэцэн дээр шинэчлэх
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);

  async function run(id: number, fn: () => Promise<unknown>, ok: string) {
    setError(null); setBusy(id);
    try { await fn(); setFlash(ok); await load(); return true; } catch (e) { setError(msg(e)); return false; } finally { setBusy(null); }
  }

  const sup = !!data?.supervise;
  const counts = data?.counts ?? {};
  const list: (Note & { _transferId?: number; _from?: string })[] = tab === 'incoming' ? (data?.incoming ?? []).map((t) => ({ ...t.note, _transferId: t.transferId, _from: t.fromName })) : (data?.items ?? []);
  const selectable = tab === 'PENDING' || tab === 'CONTACTED';

  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-[13px]">
      <AddForm pages={pages} onAdded={(n) => { setFlash(`${n} дугаар бүртгэлээ`); setTab('PENDING'); setPage(1); load(); }} onError={setError} />

      <div className="flex flex-wrap items-center gap-2">
        {sup ? (
          <select aria-label="Хамрах хүрээ" value={scope} onChange={(e) => { setScope(e.target.value as 'own' | 'all'); setOwner(''); setPage(1); setSel(new Set()); }} className={clsx(inp, 'w-[170px]')}>
            <option value="own">Зөвхөн минийх</option>
            <option value="all">Бүх оператор</option>
          </select>
        ) : null}
        {sup && scope === 'all' ? (
          <select aria-label="Оператор" value={owner} onChange={(e) => { setOwner(e.target.value); setPage(1); }} className={clsx(inp, 'w-[180px]')}>
            <option value="">Бүгд</option>
            {ops.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        ) : null}
        <label className="relative min-w-[180px] flex-1">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle"><Icon name="search" size={14} /></span>
          <input type="search" inputMode="numeric" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Хайх (утас)..." className={clsx(inp, 'pl-8')} />
        </label>
      </div>

      <div className="flex flex-wrap gap-1 rounded-lg bg-surface2 p-1">
        {TABS.filter((t) => t.v !== 'incoming' || scope === 'own').map((t) => {
          const n = t.v === 'incoming' ? data?.incoming.length ?? 0 : counts[t.v] ?? 0;
          return (
            <button key={t.v} type="button" aria-pressed={tab === t.v} onClick={() => { setTab(t.v); setPage(1); setSel(new Set()); }}
              className={clsx('inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-semibold', tab === t.v ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink')}>
              <span aria-hidden>{t.icon}</span>{t.l} ({n})
            </button>
          );
        })}
      </div>
      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}

      {selectable && sel.size ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft p-2">
          <span className="font-bold">{sel.size} сонгосон</span>
          <select aria-label="Шилжүүлэх оператор" value={bulkTo} onChange={(e) => setBulkTo(e.target.value)} className={clsx(inp, 'w-[180px]')}>
            <option value="">— Оператор —</option>
            {ops.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <Button size="sm" variant="dark" disabled={!bulkTo} loading={busy === 0} onClick={async () => {
            const ids = [...sel];
            const ok = sup
              ? await run(0, () => api('/api/calls/reassign', { method: 'POST', json: { ids, toUserId: bulkTo } }), `${ids.length} бүртгэл шилжүүллээ`)
              : await run(0, () => Promise.all(ids.map((id) => api(`/api/calls/${id}/transfer`, { method: 'POST', json: { toUserId: bulkTo } }))), 'Шилжүүлэх хүсэлт илгээлээ');
            if (ok) { setSel(new Set()); setBulkTo(''); }
          }}>{sup ? 'Шууд шилжүүлэх' : 'Шилжүүлэх хүсэлт'}</Button>
          <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Болих</Button>
        </div>
      ) : null}
      {selectable && list.length ? (
        <label className="flex items-center gap-2 text-[12.5px] text-muted">
          <input type="checkbox" className="h-4 w-4" checked={list.every((n) => sel.has(n.id))} onChange={(e) => setSel(e.target.checked ? new Set(list.filter((n) => !n.pendingTransferTo).map((n) => n.id)) : new Set())} />Бүгдийг сонгох
        </label>
      ) : null}

      {!data ? <p className="py-6 text-center text-muted">Ачаалж байна…</p> : !list.length ? <p className="py-8 text-center text-subtle">{tab === 'PENDING' ? 'Залгаагүй бүртгэл алга' : tab === 'CONTACTED' ? 'Залгасан бүртгэл алга' : tab === 'incoming' ? 'Шилжиж ирсэн хүсэлт алга' : tab === 'ORDERED' ? 'Захиалга үүссэн бүртгэл алга' : 'Цуцласан бүртгэл алга'}</p> : (
        <div className="flex flex-col gap-1.5">
          {list.map((n) => {
            const open = ['PENDING', 'CONTACTED'].includes(n.status);
            const wait = n.canAttemptAt ? Math.max(0, Math.ceil((new Date(n.canAttemptAt).getTime() - Date.now()) / 60000)) : 0;
            const incoming = n._transferId !== undefined;
            const outgoing = !!n.pendingTransferTo;
            return (
              <div key={n.id} className={clsx('flex flex-col gap-1.5 rounded-lg border p-2.5', outgoing ? 'border-accent/40 bg-accent-soft/40' : sel.has(n.id) ? 'border-info bg-info-soft/50' : n.status === 'CONTACTED' ? 'border-info/30 bg-info-soft/20' : 'border-line bg-surface')}>
                <div className="flex flex-wrap items-center gap-2">
                  {selectable && !outgoing ? <input type="checkbox" aria-label="Сонгох" className="h-4 w-4" checked={sel.has(n.id)} onChange={(e) => setSel((s) => { const x = new Set(s); if (e.target.checked) x.add(n.id); else x.delete(n.id); return x; })} /> : null}
                  {outgoing ? <span className="rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-bold text-on-accent">⇄ {n.pendingTransferTo}-д шилжүүлж байна</span> : null}
                  {n.orderNumber ? <Link href={`/orders/${n.orderId}`} className="rounded-md bg-ok-soft px-1.5 py-0.5 text-[11.5px] font-bold text-ok-ink">#{n.orderNumber}</Link> : null}
                  <a href={`tel:${n.phone}`} className="select-text font-mono text-[13.5px] font-bold">{formatPhone(n.phone)}</a>
                  {n.productCode ? <span className="rounded border border-line px-1.5 font-mono text-[11.5px]">{n.productCode}</span> : null}
                  {n.product ? <span className="text-[12.5px]">{n.product.replace(/\s*\([^)]*\)$/, '')}</span> : <span className="rounded border border-dashed border-line px-1.5 text-[11.5px] text-subtle">Бараа мэдэгдэхгүй</span>}
                  {n.pageName ? <span className="rounded bg-surface2 px-1.5 text-[11.5px] font-semibold">{n.pageName}</span> : null}
                  {incoming ? <span className="rounded bg-warn-soft px-1.5 text-[11.5px] font-semibold text-warn">{n._from}-аас</span> : null}
                  <span className="ml-auto flex flex-wrap items-center gap-1">
                    {incoming ? <>
                      <button type="button" className={clsx(sbtn, 'bg-ink text-on-ink')} onClick={() => run(-n.id, () => api(`/api/calls/transfers/${n._transferId}`, { method: 'POST', json: { accept: true } }), 'Хүлээн авлаа')}>Хүлээн авах</button>
                      <button type="button" className={clsx(sbtn, 'border border-line')} onClick={() => run(-n.id, () => api(`/api/calls/transfers/${n._transferId}`, { method: 'POST', json: { accept: false } }), 'Татгалзлаа')}>Татгалзах</button>
                    </> : open && !outgoing ? <>
                      <button type="button" className={clsx(sbtn, 'bg-accent text-on-accent')} onClick={() => onCreateOrder({ phone: n.phone, pageId: n.pageId, variantId: n.variantId, code: n.productCode })}>🛒 Захиалга</button>
                      <button type="button" className={clsx(sbtn, 'border border-line bg-surface')} onClick={() => { setTransferring(transferring === n.id ? null : n.id); setTarget(''); }}>⇄ Шилжүүлэх</button>
                      <button type="button" className={clsx(sbtn, 'text-bad-ink hover:bg-bad-soft')} onClick={() => setClosing(n)}>⛔ Цуцлах</button>
                    </> : null}
                  </span>
                </div>
                {transferring === n.id ? (
                  <div className="flex items-center gap-2">
                    <select aria-label="Оператор сонгох" value={target} onChange={(e) => setTarget(e.target.value)} className={clsx(inp, 'h-8 flex-1')}>
                      <option value="">Оператор сонго</option>
                      {ops.filter((o) => o.id !== n.ownerId).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                    <Button size="sm" variant="dark" disabled={!target} loading={busy === n.id} onClick={async () => { if (await run(n.id, () => api(`/api/calls/${n.id}/transfer`, { method: 'POST', json: { toUserId: target } }), 'Шилжүүлэх хүсэлт илгээлээ')) setTransferring(null); }}>Илгээх</Button>
                    <Button size="sm" variant="ghost" onClick={() => setTransferring(null)}>Болих</Button>
                  </div>
                ) : null}
                {open && !incoming && !outgoing ? (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="mr-1 text-[11px] text-subtle">Залгасан:</span>
                    {[0, 1, 2, 3, 4].map((i) => {
                      const done = i < n.attempts;
                      const next = i === n.attempts;
                      const gated = next && wait > 0;
                      const disabled = !next || gated || busy === n.id;
                      return (
                        <button key={i} type="button" disabled={disabled} aria-label={`${i + 1}-р залгалт`}
                          title={done ? 'Залгасан' : gated ? `30 минут болоогүй — ${wait} минутын дараа` : next ? 'Дарж бүртгэх' : ''}
                          onClick={() => run(n.id, () => api(`/api/calls/${n.id}/attempt`, { method: 'POST', json: {} }), `${i + 1}-р залгалт бүртгэлээ`)}
                          className={clsx('grid h-6 w-6 place-items-center rounded border text-[11px] font-bold', done ? 'border-info bg-info text-on-accent' : gated ? 'cursor-not-allowed border-line bg-surface2 text-subtle' : next ? 'border-info text-info hover:bg-info-soft' : 'cursor-not-allowed border-line/60 text-subtle/60')}>
                          {i + 1}
                        </button>
                      );
                    })}
                    {wait > 0 && n.attempts < 5 ? <span className="ml-1 text-[11px] text-warn">⏱ {wait} мин</span> : null}
                  </div>
                ) : null}
                {n.closeLabel ? <p className="text-[12px] text-bad-ink">Шалтгаан: {n.closeLabel}{n.closeNote ? ` — ${n.closeNote}` : ''}</p> : null}
                <p className="text-[11px] text-subtle">{n.ownerName} - {ubDateTime(n.createdAt)}{n.note ? ` · ${n.note}` : ''}</p>
              </div>
            );
          })}
        </div>
      )}
      {data && tab !== 'incoming' && data.total > data.pageSize ? (
        <div className="flex items-center justify-center gap-3">
          <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Өмнөх</Button>
          <span className="text-[12px] text-muted">{page} / {Math.ceil(data.total / data.pageSize)}</span>
          <Button size="sm" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Дараах</Button>
        </div>
      ) : null}
      <CloseModal note={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); setFlash('Бүртгэл цуцлагдлаа'); load(); }} />
    </div>
  );
}

/** Хуучин шиг нэмэх хэсэг: Бараа (код/нэр) · Утас (олон мөр, Enter → дараагийн) · Пэйж · Бүртгэх */
function AddForm({ pages, onAdded, onError }: { pages: { id: number; name: string }[]; onAdded: (n: number) => void; onError: (m: string | null) => void }) {
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [hit, setHit] = useState<Hit | null>(null);
  const [suggest, setSuggest] = useState(false);
  const [phones, setPhones] = useState<string[]>(['']);
  const [pageId, setPageId] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = useRef<(HTMLInputElement | null)[]>([]);
  useEffect(() => {
    if (term.trim().length < 2 || hit) { setHits([]); return; }
    const t = setTimeout(() => api<{ items: Hit[] }>(`/api/products/search?q=${encodeURIComponent(term)}&limit=8`).then((r) => setHits(r.items)).catch(() => undefined), 200);
    return () => clearTimeout(t);
  }, [term, hit]);
  const valid = phones.map((p) => p.replace(/\D/g, '')).filter((p) => p.length >= 8);
  async function submit() {
    if (!valid.length) { onError('Утасны дугаар оруулна уу'); return; }
    setBusy(true); onError(null);
    try {
      const r = await api<{ created: number }>('/api/calls', { method: 'POST', json: { phones: valid.join(' '), variantId: hit?.variantId, productText: hit ? undefined : term.trim() || undefined, pageId: pageId || undefined } });
      setPhones(['']); setTerm(''); setHit(null);
      onAdded(r.created);
      setTimeout(() => rows.current[0]?.focus(), 0);
    } catch (e) { onError(msg(e)); } finally { setBusy(false); }
  }
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface2/50 p-3">
      <div className="grid gap-2.5 md:grid-cols-3">
        <div className="relative flex flex-col gap-1">
          <span className="text-[12px] font-semibold text-muted">Бараа (код/нэр)</span>
          <div className="relative">
            <input value={hit ? `${hit.variantCode} ${hit.fullName}` : term} onChange={(e) => { setHit(null); setTerm(e.target.value); setSuggest(true); }} onFocus={() => setSuggest(true)} onBlur={() => setTimeout(() => setSuggest(false), 150)}
              placeholder="0001 эсвэл нэр..." aria-label="Бараа (код/нэр)" data-autofocus className={clsx(inp, 'pr-7')} />
            {term || hit ? <button type="button" aria-label="Цэвэрлэх" onMouseDown={(e) => { e.preventDefault(); setTerm(''); setHit(null); }} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-subtle"><Icon name="close" size={13} /></button> : null}
          </div>
          {suggest && hits.length ? (
            <div className="absolute top-full z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line bg-surface shadow-pop">
              {hits.map((h) => (
                <button key={h.variantId} type="button" onMouseDown={(e) => { e.preventDefault(); setHit(h); setSuggest(false); }} className="flex w-full items-start gap-2 px-2 py-1.5 text-left text-[12.5px] hover:bg-surface2">
                  <span className="shrink-0 rounded border border-line px-1 font-mono text-[11px]">{h.variantCode}</span><span className="leading-tight">{h.fullName}</span><span className="ml-auto shrink-0 text-subtle">{h.available}ш</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <span className="flex items-center justify-between text-[12px] font-semibold text-muted">
            <span>Утас <span className="text-bad-ink">*</span></span>{valid.length > 1 ? <span className="text-[11px] text-info">{valid.length} дугаар</span> : null}
          </span>
          {phones.map((p, i) => (
            <div key={i} className="flex gap-1">
              <input ref={(el) => { rows.current[i] = el; }} value={p} inputMode="numeric" placeholder={i === 0 ? '99112233' : 'Дараагийн дугаар'} aria-label={`Утас ${i + 1}`}
                onChange={(e) => setPhones((ps) => ps.map((x, j) => (j === i ? e.target.value.replace(/[^\d\s]/g, '') : x)))}
                onPaste={(e) => {
                  const found = e.clipboardData.getData('text').match(/\d{4}[\s-]?\d{4}/g);
                  if (found && found.length > 1) { e.preventDefault(); setPhones((ps) => [...ps.slice(0, i), ...found.map((f) => f.replace(/\D/g, '')), ...ps.slice(i + 1)].filter((x, j, a) => x || j === a.length - 1)); }
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  if (i === phones.length - 1 && p.replace(/\D/g, '').length >= 8) { setPhones((ps) => [...ps, '']); setTimeout(() => rows.current[i + 1]?.focus(), 0); }
                  else if (i < phones.length - 1) rows.current[i + 1]?.focus();
                }}
                className={clsx(inp, 'font-mono')} />
              {phones.length > 1 ? <button type="button" aria-label="Мөр устгах" onClick={() => setPhones((ps) => ps.filter((_, j) => j !== i))} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-subtle hover:text-bad-ink"><Icon name="close" size={14} /></button> : null}
            </div>
          ))}
          <button type="button" onClick={() => { setPhones((ps) => [...ps, '']); setTimeout(() => rows.current[phones.length]?.focus(), 0); }} className="flex h-7 items-center justify-center gap-1 rounded-md border border-dashed border-info/40 text-[12px] font-semibold text-info hover:bg-info-soft">
            <Icon name="plus" size={13} />Дугаар нэмэх
          </button>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-semibold text-muted">Пэйж</span>
          <select value={pageId} onChange={(e) => setPageId(e.target.value)} className={inp}>
            <option value="">--</option>
            {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="primary" loading={busy} onClick={submit}><Icon name="plus" size={14} />Бүртгэх</Button>
      </div>
    </div>
  );
}

/** Цуцлах (#54): систем шалтгааныг урьдчилан сонгоно, өөр бол гараар солино */
function CloseModal({ note, onClose, onDone }: { note: Note | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [text, setText] = useState('');
  const [suggested, setSuggested] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    setReason(''); setText(''); setError(null); setSuggested(null);
    api<{ reason: string | null }>(`/api/calls/${note.id}/suggest`).then((r) => { setSuggested(r.reason); if (r.reason) setReason(r.reason); }).catch(() => undefined);
  }, [note]);
  return (
    <Modal open={!!note} onClose={onClose} title={note ? `${formatPhone(note.phone)} — цуцлах` : ''}
      footer={<><Button onClick={onClose}>Болих</Button><Button variant="danger" loading={busy} disabled={!reason || (reason === 'OTHER' && text.trim().length < 3)}
        onClick={async () => {
          if (!note) return;
          setBusy(true); setError(null);
          try { await api(`/api/calls/${note.id}/close`, { method: 'POST', json: { reason, note: text } }); onDone(); }
          catch (e) { setError(msg(e)); } finally { setBusy(false); }
        }}>Цуцлах</Button></>}>
      <div className="flex flex-col gap-3">
        {error ? <Notice>{error}</Notice> : null}
        <p className="text-[13px] text-muted">Яагаад захиалга болсонгүй вэ?{suggested ? ' Систем урьдчилан сонгосон — өөр бол солино уу.' : ''}</p>
        <div className="grid grid-cols-2 gap-2">
          {CLOSE.map((c) => (
            <button key={c.v} type="button" aria-pressed={reason === c.v} onClick={() => setReason(c.v)}
              className={clsx('min-h-10 rounded-lg border px-3 py-2 text-left text-[13px] font-semibold', reason === c.v ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>
              {c.l}{suggested === c.v ? <span className="block text-[11px] font-normal opacity-75">систем санал болгосон</span> : null}
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">{reason === 'OTHER' ? 'Шалтгаанаа бичнэ үү' : 'Нэмэлт тайлбар (заавал биш)'}
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} className={inp} />
        </label>
      </div>
    </Modal>
  );
}
