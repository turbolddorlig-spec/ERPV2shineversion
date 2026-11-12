'use client';
import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { ReasonModal } from '@/components/ui/ReasonModal';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';
import { money, ubDateTime } from '@/lib/format';
import { ItemPicker, newKey, type PickLine } from './ItemPicker';

type LStatus = 'REQUESTED' | 'ISSUED' | 'CLOSED' | 'REJECTED' | 'CANCELLED';
const TONE: Record<LStatus, 'warn' | 'info' | 'ok' | 'neutral' | 'bad'> = { REQUESTED: 'warn', ISSUED: 'info', CLOSED: 'ok', REJECTED: 'bad', CANCELLED: 'neutral' };
interface LLine { id: number; variantId: number; code: string; name: string; label: string; thumb: string | null; qty: number; returnedQty: number; chargedQty: number; outstanding: number; unitPrice: number | null; deduction: number | null }
interface Loan { id: number; staffId: string; staffName: string; status: LStatus; statusLabel: string; note: string | null; decidedNote: string | null; requestedAt: string; issuedAt: string | null; issuedBy: string | null; closedAt: string | null; lines: LLine[]; outstandingQty: number; deductionDue: number }
interface Resp { items: Loan[]; total: number; pageSize: number; loanDiscount: number; can: { request: boolean; operate: boolean; finance: boolean; all: boolean } }
interface Wh { id: number; name: string; isPrimary: boolean }

const FILTERS = [{ v: 'open', l: 'Нээлттэй' }, { v: 'REQUESTED', l: 'Хүсэлт' }, { v: 'ISSUED', l: 'Олгосон' }, { v: 'CLOSED', l: 'Хаагдсан' }, { v: 'all', l: 'Бүгд' }];

/** Бараа зээл (#38): хүсэлт → агуулах олгоно → буцаалт / цалингаас суутгал (үнэ − хямдрал) */
export function LoansClient({ selfId }: { selfId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState('open');
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Resp | null>(null);
  const [whs, setWhs] = useState<Wh[]>([]);
  const [lines, setLines] = useState<PickLine[]>([]);
  const [note, setNote] = useState('');
  const [reqKey, setReqKey] = useState(newKey);
  const [discount, setDiscount] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('status');
    if (s) setStatus(s);
    api<{ items: Wh[] }>('/api/stock/warehouses').then((r) => setWhs(r.items)).catch(() => undefined);
  }, []);
  const load = useCallback(async () => {
    const r = await api<Resp>(`/api/loans?status=${status}&page=${page}${mine ? '&mine=1' : ''}`);
    setData(r); setDiscount((d) => d || String(r.loanDiscount));
  }, [status, page, mine]);
  useEffect(() => { load().catch((e) => setError(e instanceof ApiError ? e.message : 'Ачаалж чадсангүй')); }, [load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setError(null); setFlash(null); setBusy(true);
    try { await fn(); setFlash(ok); await load(); router.refresh(); return true; }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Алдаа'); return false; } finally { setBusy(false); }
  }

  const can = data?.can;
  const chip = (on: boolean) => clsx('h-10 shrink-0 rounded-full border px-4 text-[13.5px] font-semibold', on ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-ink');
  return (
    <div className="flex flex-col gap-4">
      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}

      {can?.request ? (
        <section className="flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
          <h2 className="text-[16px] font-extrabold">Бараа зээл хүсэх</h2>
          <ItemPicker lines={lines} onChange={setLines} />
          <Field id="l-note" label="Юунд хэрэгтэй вэ? (заавал биш)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Жишээ: Зураг авалтад" />
          <div className="flex justify-end">
            <Button variant="primary" loading={busy} disabled={!lines.some((l) => l.qty > 0)}
              onClick={async () => { if (await run(() => api('/api/loans', { method: 'POST', json: { lines: lines.filter((l) => l.qty > 0).map((l) => ({ variantId: l.variantId, qty: l.qty })), note, idemKey: reqKey } }), 'Хүсэлт илгээгдлээ — агуулах олгохдоо батална')) { setLines([]); setNote(''); setReqKey(newKey()); } }}>
              Хүсэлт илгээх
            </Button>
          </div>
        </section>
      ) : null}

      {can?.finance ? (
        <section className="flex flex-wrap items-end gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
          <Field id="disc" className="w-48" label="Зээлийн хямдрал (нэгж бүрд)" inputMode="numeric" value={discount} onChange={(e) => setDiscount(e.target.value.replace(/[^\d]/g, ''))} hint="Суутгал = үнэ − хямдрал" />
          <Button loading={busy} disabled={discount === String(data?.loanDiscount)} onClick={() => run(() => api('/api/loans/settings', { method: 'POST', json: { loanDiscount: Number(discount) } }), `Хямдрал ${money(Number(discount))} боллоо (шинээр олгох зээлд)`)}>Хадгалах</Button>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => <button key={f.v} type="button" aria-pressed={status === f.v} onClick={() => { setStatus(f.v); setPage(1); }} className={chip(status === f.v)}>{f.l}</button>)}
        {can?.all && can.request ? <label className="ml-auto inline-flex h-10 items-center gap-2 text-[13.5px] font-semibold"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} className="h-[18px] w-[18px] accent-[var(--accent)]" />Зөвхөн миний</label> : null}
      </div>

      <ul className="flex flex-col gap-3">
        {data?.items.map((l) => <LoanCard key={l.id} loan={l} can={can!} selfId={selfId} whs={whs} busy={busy} run={run} />)}
      </ul>
      {data && !data.items.length ? <div className="rounded-[16px] border border-dashed border-line bg-surface p-8 text-center text-muted">Зээл алга</div> : null}
      {data && data.total > data.pageSize ? (
        <div className="flex justify-end gap-2">
          <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><Icon name="left" size={15} /> Өмнөх</Button>
          <Button size="sm" disabled={page * data.pageSize >= data.total} onClick={() => setPage((p) => p + 1)}>Дараах <Icon name="right" size={15} /></Button>
        </div>
      ) : null}
    </div>
  );
}

function LoanCard({ loan: l, can, selfId, whs, busy, run }: {
  loan: Loan; can: Resp['can']; selfId: string; whs: Wh[]; busy: boolean; run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean>;
}) {
  const primary = String(whs.find((w) => w.isPrimary)?.id ?? '');
  const [wh, setWh] = useState('');
  const [mode, setMode] = useState<null | 'issue' | 'return'>(null);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [ded, setDed] = useState<Record<number, string>>({});
  const [retKey, setRetKey] = useState(newKey);
  const [reject, setReject] = useState(false);
  const whSel = wh || primary;

  const open = (m: 'issue' | 'return') => { setMode(m); setQty(Object.fromEntries(l.lines.map((x) => [x.variantId, String(m === 'issue' ? x.qty : x.outstanding)]))); };
  const post = (action: string, json: unknown) => api(`/api/loans/${l.id}/${action}`, { method: 'POST', json });

  return (
    <li className={clsx('flex flex-col gap-3 rounded-[18px] border bg-surface p-4 shadow-card', l.status === 'REQUESTED' ? 'border-warn/50' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-bold text-subtle">№{l.id}</span>
        <span className="flex-1 text-[16px] font-bold">{l.staffName}</span>
        <Badge tone={TONE[l.status]}>{l.statusLabel}</Badge>
      </div>
      <p className="text-[12.5px] text-subtle">Хүссэн: {ubDateTime(l.requestedAt)}{l.issuedAt ? ` · Олгосон: ${l.issuedBy}, ${ubDateTime(l.issuedAt)}` : ''}{l.closedAt ? ` · Хаагдсан: ${ubDateTime(l.closedAt)}` : ''}{l.note ? ` · ${l.note}` : ''}{l.decidedNote ? ` · Тайлбар: ${l.decidedNote}` : ''}</p>
      <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
        {l.lines.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
            <Thumb src={x.thumb} alt={`${x.name} ${x.label}`} size={40} zoom={x.code} />
            <span className="flex min-w-[150px] flex-1 flex-col">
              <span className="text-[14px] font-semibold">{x.name}{x.label ? <span className="text-muted"> · {x.label}</span> : null}</span>
              <span className="text-[12px] text-subtle">{x.code} · {x.qty} ширхэг{x.returnedQty ? ` · буцаасан ${x.returnedQty}` : ''}{x.chargedQty ? ` · цалингаас ${x.chargedQty}` : ''}{l.status === 'ISSUED' ? ` · үлдсэн ${x.outstanding}` : ''}</span>
            </span>
            {x.deduction !== null ? (
              can.finance && l.status === 'ISSUED' ? (
                <span className="flex items-center gap-1.5">
                  <input inputMode="numeric" aria-label={`${x.code} нэгжийн суутгал`} value={ded[x.variantId] ?? String(x.deduction)} onChange={(e) => setDed((d) => ({ ...d, [x.variantId]: e.target.value.replace(/[^\d]/g, '') }))}
                    className="h-10 w-28 rounded-lg border border-line bg-surface px-2 text-right font-semibold outline-none focus:border-accent" />
                  {ded[x.variantId] !== undefined && ded[x.variantId] !== String(x.deduction) ? <Button size="sm" loading={busy} onClick={() => run(() => post('deduction', { variantId: x.variantId, deduction: Number(ded[x.variantId]) }), 'Суутгал засагдлаа')}>Хадгалах</Button> : <span className="text-[12px] text-subtle">₮/ш</span>}
                </span>
              ) : <span className="text-[12.5px] text-muted">Суутгал {money(x.deduction)}/ш{x.unitPrice ? ` (үнэ ${money(x.unitPrice)})` : ''}</span>
            ) : null}
            {mode ? (
              <span className="flex items-center gap-1.5 text-[12px] text-subtle">
                <input inputMode="numeric" aria-label={`${x.code} ${mode === 'issue' ? 'олгох' : 'буцаах'} тоо`} value={qty[x.variantId] ?? ''} onChange={(e) => setQty((q) => ({ ...q, [x.variantId]: e.target.value.replace(/[^\d]/g, '') }))}
                  className="h-11 w-20 rounded-lg border border-line bg-surface text-center text-[16px] font-bold outline-none focus:border-accent" />
                {mode === 'issue' ? 'олгох' : 'буцсан'}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {l.status === 'ISSUED' && l.deductionDue > 0 ? <p className="text-[13.5px] font-semibold">Буцаагаагүй бол цалингаас: <span className="text-bad-ink">{money(l.deductionDue)}</span> <span className="font-normal text-muted">(цалин бодоход автоматаар орж, цалин түгжихэд суутгагдана)</span></p> : null}

      {mode ? (
        <div className="flex flex-wrap items-end gap-2 rounded-xl bg-surface2 p-3">
          <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">{mode === 'issue' ? 'Аль агуулахаас' : 'Аль агуулах руу'}
            <select value={whSel} onChange={(e) => setWh(e.target.value)} className="h-11 rounded-xl border border-line bg-surface px-3 text-ink">{whs.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          </label>
          <span className="flex-1" />
          <Button onClick={() => setMode(null)}>Болих</Button>
          <Button variant="primary" loading={busy} onClick={async () => {
            const ok = mode === 'issue'
              ? await run(() => post('issue', { warehouseId: Number(whSel), lines: l.lines.map((x) => ({ variantId: x.variantId, qty: Number(qty[x.variantId] ?? 0) })) }), 'Зээл олгогдлоо')
              : await run(() => post('return', { warehouseId: Number(whSel), idemKey: retKey, lines: l.lines.map((x) => ({ variantId: x.variantId, qty: Number(qty[x.variantId] ?? 0) })).filter((x) => x.qty > 0) }), 'Буцаалт хүлээн авлаа');
            if (ok) { setMode(null); setRetKey(newKey()); }
          }}>{mode === 'issue' ? 'Олгох' : 'Буцаалт хүлээн авах'}</Button>
        </div>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          {l.status === 'REQUESTED' && l.staffId === selfId ? <Button variant="danger" loading={busy} onClick={() => run(() => post('cancel', {}), 'Хүсэлт цуцлагдлаа')}>Цуцлах</Button> : null}
          {l.status === 'REQUESTED' && can.operate ? <><Button variant="danger" onClick={() => setReject(true)}>Татгалзах</Button><Button variant="primary" onClick={() => open('issue')}>Олгох</Button></> : null}
          {l.status === 'ISSUED' && can.operate ? <Button variant="dark" onClick={() => open('return')}>Буцаалт хүлээн авах</Button> : null}
        </div>
      )}
      <ReasonModal open={reject} title="Зээлийн хүсэлт татгалзах" label="Шалтгаан" confirmText="Татгалзах" busy={busy} onCancel={() => setReject(false)}
        onConfirm={async (note) => { if (await run(() => post('reject', { note }), 'Татгалзлаа')) setReject(false); }} />
    </li>
  );
}
