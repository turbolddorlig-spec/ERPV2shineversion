'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/Field';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';
import { ubDateTime } from '@/lib/format';

type CStatus = 'OPEN' | 'SUBMITTED' | 'CLOSED' | 'CANCELLED';
const TONE: Record<CStatus, 'info' | 'warn' | 'ok' | 'neutral'> = { OPEN: 'info', SUBMITTED: 'warn', CLOSED: 'ok', CANCELLED: 'neutral' };
interface CItem { id: number; warehouse: { id: number; name: string }; status: CStatus; statusLabel: string; note: string | null; lines: number; diffLines: number; createdBy: string; createdAt: string }
interface Wh { id: number; name: string; isPrimary: boolean }

export function CountsClient({ canOperate }: { canOperate: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState('open');
  const [data, setData] = useState<{ items: CItem[] } | null>(null);
  const [whs, setWhs] = useState<Wh[]>([]);
  const [wh, setWh] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('status');
    if (s) setStatus(s);
    api<{ items: Wh[] }>('/api/stock/warehouses').then((r) => { setWhs(r.items); setWh(String(r.items.find((w) => w.isPrimary)?.id ?? '')); }).catch(() => undefined);
  }, []);
  useEffect(() => { api<{ items: CItem[] }>(`/api/stock/counts?status=${status}`).then(setData).catch(() => undefined); }, [status]);

  async function start() {
    setError(null); setBusy(true);
    try {
      const r = await api<{ count: { id: number } }>('/api/stock/counts', { method: 'POST', json: { warehouseId: Number(wh), note } });
      router.push(`/warehouse/counts/${r.count.id}`);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Алдаа'); setBusy(false); }
  }
  const chip = (on: boolean) => clsx('h-10 shrink-0 rounded-full border px-4 text-[13.5px] font-semibold', on ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-ink');
  return (
    <div className="flex flex-col gap-4">
      {canOperate ? (
        <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card sm:grid-cols-[1fr_2fr_auto] sm:items-end">
          <Select id="c-wh" label="Агуулах" value={wh} onChange={(e) => setWh(e.target.value)}>
            {whs.map((w) => <option key={w.id} value={w.id}>{w.name}{w.isPrimary ? ' (үндсэн)' : ''}</option>)}
          </Select>
          <Field id="c-note" label="Тайлбар (5+ тэмдэгт)" placeholder="Жишээ: 11-р сарын тооллого" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button variant="primary" loading={busy} onClick={start} disabled={!wh}><Icon name="plus" size={16} />Тооллого эхлүүлэх</Button>
          {error ? <div className="sm:col-span-3"><Notice>{error}</Notice></div> : null}
        </section>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {[{ v: 'open', l: 'Нээлттэй' }, { v: 'SUBMITTED', l: 'Батлах хүлээгдэж буй' }, { v: 'all', l: 'Бүгд' }].map((f) => (
          <button key={f.v} type="button" aria-pressed={status === f.v} onClick={() => setStatus(f.v)} className={chip(status === f.v)}>{f.l}</button>
        ))}
      </div>
      <ul className="flex flex-col gap-2">
        {data?.items.map((c) => (
          <li key={c.id}>
            <Link href={`/warehouse/counts/${c.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[16px] border border-line bg-surface p-3.5 shadow-card hover:bg-surface2/60">
              <span className="text-[13px] font-bold text-subtle">№{c.id}</span>
              <span className="flex-1 text-[15px] font-bold">{c.warehouse.name}</span>
              <Badge tone={TONE[c.status]}>{c.statusLabel}</Badge>
              <span className="w-full text-[13px] text-muted">{c.lines} бараа тоолсон{c.diffLines ? <span className="font-bold text-bad-ink"> · {c.diffLines} зөрүүтэй</span> : ''} · {c.note} · {c.createdBy}, {ubDateTime(c.createdAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {data && !data.items.length ? <div className="rounded-[16px] border border-dashed border-line bg-surface p-8 text-center text-muted">Тооллого алга</div> : null}
    </div>
  );
}

interface CLine {
  id: number; variantId: number; productId: number; code: string; name: string; label: string; thumb: string | null; shelfCode: string | null;
  systemQty: number; countedQty: number; diff: number; currentQty: number; movedSince: boolean; status: 'PENDING' | 'APPROVED' | 'REJECTED'; countedBy: string; decidedBy: string | null; appliedDelta: number | null;
}
interface CDetail { id: number; status: CStatus; statusLabel: string; note: string | null; warehouse: { id: number; name: string }; createdBy: string; createdAt: string; lines: CLine[] }
interface SRow { variantId: number; code: string; name: string; label: string; thumb: string | null; shelfCode: string | null; byWarehouse: Record<string, number> }
interface Hit { variantId: number; variantCode: string; fullName: string; name: string; label: string; thumb: string | null }

export function CountDetail({ id, canOperate, canApprove }: { id: number; canOperate: boolean; canApprove: boolean }) {
  const router = useRouter();
  const [c, setC] = useState<CDetail | null>(null);
  const [sheet, setSheet] = useState<{ items: SRow[]; hasMore: boolean; pageSize: number } | null>(null);
  const [page, setPage] = useState(1);
  const [vals, setVals] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<Record<number, 'saving' | 'ok' | 'err'>>({});
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [extra, setExtra] = useState<Hit[]>([]);
  const qReq = useRef(0);

  const load = useCallback(async () => {
    const r = await api<{ count: CDetail }>(`/api/stock/counts/${id}`);
    setC(r.count);
    setVals((v) => ({ ...Object.fromEntries(r.count.lines.map((l) => [l.variantId, String(l.countedQty)])), ...v }));
  }, [id]);
  useEffect(() => { load().catch((e) => setError(e instanceof ApiError ? e.message : 'Ачаалж чадсангүй')); }, [load]);
  const open = c?.status === 'OPEN' && canOperate;
  useEffect(() => {
    if (!c || c.status !== 'OPEN') return;
    api<{ items: SRow[]; hasMore: boolean; pageSize: number }>(`/api/stock?warehouseId=${c.warehouse.id}&inStock=1&sort=shelf&page=${page}`).then(setSheet).catch(() => undefined);
  }, [c?.status, c?.warehouse.id, page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const term = q.trim(); if (!term) { setHits([]); return; }
    const rid = ++qReq.current;
    const t = setTimeout(() => api<{ items: Hit[] }>(`/api/products/search?q=${encodeURIComponent(term)}&limit=8`).then((r) => rid === qReq.current && setHits(r.items)).catch(() => undefined), 220);
    return () => clearTimeout(t);
  }, [q]);

  async function save(variantId: number) {
    const raw = vals[variantId];
    setSaving((s) => ({ ...s, [variantId]: 'saving' }));
    try {
      await api(`/api/stock/counts/${id}/line`, { method: 'POST', json: { variantId, countedQty: raw === '' || raw === undefined ? null : Number(raw) } });
      setSaving((s) => ({ ...s, [variantId]: 'ok' }));
      await load();
    } catch (e) { setSaving((s) => ({ ...s, [variantId]: 'err' })); setError(e instanceof ApiError ? e.message : 'Хадгалж чадсангүй'); }
  }
  async function act(path: string, body: unknown = {}) {
    setError(null); setBusy(true);
    try { await api(`/api/stock/counts/${id}/${path}`, { method: 'POST', json: body }); setSel(new Set()); router.refresh(); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Алдаа'); } finally { setBusy(false); }
  }

  if (!c) return error ? <Notice>{error}</Notice> : <p className="text-muted">Ачаалж байна…</p>;
  const counted = new Map(c.lines.map((l) => [l.variantId, l]));
  const pending = c.lines.filter((l) => l.status === 'PENDING');
  const deciding = c.status === 'SUBMITTED' && canApprove;
  const diffN = c.lines.filter((l) => l.diff !== 0).length;
  const input = (variantId: number) => (
    <span className="flex items-center gap-1.5">
      <input inputMode="numeric" aria-label="Тоолсон тоо" value={vals[variantId] ?? ''} placeholder="—"
        onChange={(e) => setVals((v) => ({ ...v, [variantId]: e.target.value.replace(/[^\d]/g, '') }))} onBlur={() => (vals[variantId] ?? '') !== String(counted.get(variantId)?.countedQty ?? '') && save(variantId)}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className={clsx('h-11 w-20 rounded-lg border bg-surface text-center text-[16px] font-bold outline-none focus:border-accent', saving[variantId] === 'err' ? 'border-bad' : 'border-line')} />
      <span className="w-5 text-ok-ink">{saving[variantId] === 'ok' ? <Icon name="check" size={16} /> : saving[variantId] === 'saving' ? '…' : null}</span>
    </span>
  );

  return (
    <div className="flex flex-col gap-4 pb-24">
      <section className="flex flex-wrap items-center gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
        <span className="text-[18px] font-extrabold">{c.warehouse.name}</span>
        <Badge tone={TONE[c.status]}>{c.statusLabel}</Badge>
        <span className="text-[13px] text-muted">{c.note} · {c.createdBy}, {ubDateTime(c.createdAt)}</span>
        <span className="w-full text-[13.5px] font-semibold">{c.lines.length} бараа тоолсон · <span className={diffN ? 'text-bad-ink' : 'text-ok-ink'}>{diffN} зөрүүтэй</span></span>
      </section>
      {error ? <Notice>{error}</Notice> : null}

      {open ? (
        <>
          <Notice tone="info">Бараагаа тоолж тоог оруулна (Enter эсвэл дараагийн нүд рүү шилжихэд хадгалагдана). Дуусаад «Админд илгээх» дарна. Системийн тоо тоолох үед харагдахгүй — бодит тоогоо л бичнэ.</Notice>
          <section className="flex flex-col gap-2 rounded-[18px] border border-line bg-surface p-4 shadow-card">
            <label htmlFor="cq" className="text-[13px] font-semibold text-muted">Жагсаалтад байхгүй бараа нэмэх</label>
            <input id="cq" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Код, нэрээр хайх…" className="h-11 rounded-xl border border-line bg-surface px-3.5 outline-none focus:border-accent" />
            {hits.length ? (
              <ul className="flex flex-col gap-1">
                {hits.map((h) => (
                  <li key={h.variantId}><button type="button" onClick={() => { setExtra((x) => (x.some((y) => y.variantId === h.variantId) ? x : [h, ...x])); setQ(''); setHits([]); }}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-surface2"><Thumb src={h.thumb} alt={h.fullName} size={36} /><span className="flex-1 text-[14px] font-semibold">{h.fullName}<span className="block text-[12px] font-normal text-subtle">{h.variantCode}</span></span><Icon name="plus" size={16} /></button></li>
                ))}
              </ul>
            ) : null}
          </section>
          <ul className="flex flex-col divide-y divide-line rounded-[18px] border border-line bg-surface shadow-card">
            {[...extra.map((h) => ({ variantId: h.variantId, code: h.variantCode, name: h.name, label: h.label === 'Үндсэн' ? '' : h.label, thumb: h.thumb, shelfCode: null as string | null })), ...(sheet?.items ?? [])].map((r) => (
              <li key={r.variantId} className="flex items-center gap-3 px-3.5 py-2.5">
                <Thumb src={r.thumb} alt={`${r.name} ${r.label}`} size={42} zoom={r.code} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[14.5px] font-semibold">{r.name}{r.label ? <span className="text-muted"> · {r.label}</span> : null}</span>
                  <span className="text-[12px] text-subtle">{r.code}{r.shelfCode ? ` · Тавиур ${r.shelfCode}` : ''}</span>
                </span>
                {input(r.variantId)}
              </li>
            ))}
          </ul>
          {sheet && (page > 1 || sheet.hasMore) ? (
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-muted">{page}-р хуудас</span>
              <div className="flex gap-2">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><Icon name="left" size={15} /> Өмнөх</Button>
                <Button size="sm" disabled={!sheet.hasMore} onClick={() => setPage((p) => p + 1)}>Дараах <Icon name="right" size={15} /></Button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-[18px] border border-line bg-surface shadow-card">
          {c.lines.map((l) => (
            <li key={l.id} className={clsx('flex flex-wrap items-center gap-3 px-3.5 py-3', l.status !== 'PENDING' && 'opacity-75')}>
              {deciding && l.status === 'PENDING' ? <input type="checkbox" aria-label={`${l.code} сонгох`} checked={sel.has(l.id)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n; })} className="h-5 w-5 accent-[var(--accent)]" /> : null}
              <Thumb src={l.thumb} alt={`${l.name} ${l.label}`} size={42} zoom={l.code} />
              <span className="flex min-w-[160px] flex-1 flex-col">
                <span className="text-[14.5px] font-semibold">{l.name}{l.label ? <span className="text-muted"> · {l.label}</span> : null}</span>
                <span className="text-[12px] text-subtle">{l.code} · <Link href={`/warehouse/products/${l.productId}?variantId=${l.variantId}`} className="font-semibold text-accent-ink">Түүх</Link></span>
              </span>
              <span className="grid grid-cols-3 gap-3 text-center text-[12px] text-subtle">
                <span><span className="block text-[16px] font-extrabold text-ink">{l.systemQty}</span>систем</span>
                <span><span className="block text-[16px] font-extrabold text-ink">{l.countedQty}</span>тоолсон</span>
                <span><span className={clsx('block text-[16px] font-extrabold', l.diff > 0 ? 'text-ok-ink' : l.diff < 0 ? 'text-bad-ink' : 'text-ink')}>{l.diff > 0 ? `+${l.diff}` : l.diff}</span>зөрүү</span>
              </span>
              <span className="flex w-full flex-wrap gap-1.5 sm:w-auto">
                {l.status === 'APPROVED' ? <Badge tone="ok">Батлагдсан · {l.decidedBy}</Badge> : l.status === 'REJECTED' ? <Badge tone="neutral">Татгалзсан</Badge> : null}
                {l.movedSince ? <Badge tone="warn">Тоолсны дараа хөдөлсөн (одоо {l.currentQty})</Badge> : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {(open || deciding || (c.status !== 'CLOSED' && c.status !== 'CANCELLED' && canOperate)) ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:left-[84px]">
          <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-end gap-2">
            <Link href="/warehouse/counts" className="inline-flex h-11 items-center rounded-[11px] border border-line bg-surface px-4 font-semibold">Буцах</Link>
            {c.status === 'OPEN' || (c.status === 'SUBMITTED' && canApprove) ? <Button variant="danger" loading={busy} onClick={() => act('cancel')}>Цуцлах</Button> : null}
            {open ? <Button variant="primary" size="lg" loading={busy} disabled={!c.lines.length} onClick={() => act('submit')}>Админд илгээх ({c.lines.length})</Button> : null}
            {deciding && pending.length ? (
              <>
                <Button disabled={!sel.size} loading={busy} onClick={() => act('decide', { lineIds: [...sel], action: 'reject' })}>Татгалзах ({sel.size})</Button>
                <Button variant="dark" disabled={!sel.size} loading={busy} onClick={() => act('decide', { lineIds: [...sel], action: 'approve' })}>Сонгосныг зөвшөөрөх ({sel.size})</Button>
                <Button variant="primary" size="lg" loading={busy} onClick={() => act('decide', { lineIds: 'all', action: 'approve' })}>Бүгдийг зөвшөөрөх ({pending.length})</Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
