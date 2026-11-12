'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Badge } from '@/components/ui/Badge';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');

// ───────────────────────── OKEY / ХОРИГ (хуучин шиг) ─────────────────────────

interface OkDriver { id: string; name: string; phone: string; orders: number; trusted: boolean; approved: boolean; approvalNote: string | null; approvalBy: string | null }
export function OkeyDialog({ date, onClose }: { date: string; onClose: () => void }) {
  const [rows, setRows] = useState<OkDriver[] | null>(null);
  const [debts, setDebts] = useState<Map<string, number>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [block, setBlock] = useState<OkDriver | null>(null);
  const [note, setNote] = useState('');
  const load = useCallback(async () => {
    try {
      const [b, d] = await Promise.all([api<{ drivers: OkDriver[] }>(`/api/handover?date=${date}`), api<{ items: { id: string; pending: number }[] }>('/api/accounting/debts')]);
      setRows(b.drivers); setDebts(new Map(d.items.map((i) => [i.id, i.pending]))); setErr(null);
    } catch (e) { setErr(msg(e)); }
  }, [date]);
  useEffect(() => { void load(); }, [load]);
  const set = async (r: OkDriver, approved: boolean, n?: string) => {
    try { await api('/api/handover/approvals', { method: 'POST', json: { driverId: r.id, date, approved, note: n } }); setBlock(null); setNote(''); await load(); } catch (e) { setErr(msg(e)); }
  };
  const trust = async (r: OkDriver) => { try { await api('/api/handover/approvals', { method: 'POST', json: { driverId: r.id, trusted: !r.trusted } }); await load(); } catch (e) { setErr(msg(e)); } };
  return (
    <Modal open onClose={onClose} size="xl" title="OKEY — жолоочид бараа өгөх зөвшөөрөл" subtitle={`${date} · ХОРИГ-той жолоочид агуулах бараа өгөхгүй. Итгэлтэй жолооч өдөр бүр автоматаар OKEY`}
      footer={<Button onClick={onClose}>Хаах</Button>}>
      {err ? <Notice>{err}</Notice> : null}
      <div className="divide-y divide-line rounded-[14px] border border-line">
        {rows?.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <div className="min-w-[160px] flex-1"><b className="[overflow-wrap:anywhere]">{r.name}</b><span className="block text-[12px] text-subtle">{r.phone} · {r.orders} захиалга{debts.get(r.id) ? <b className="text-bad-ink"> · өр {money(debts.get(r.id))}</b> : null}</span>
              {r.approvalNote ? <span className="block text-[12px] text-bad-ink [overflow-wrap:anywhere]">{r.approvalNote}</span> : null}</div>
            <Badge tone={r.approved ? 'ok' : 'bad'}>{r.approved ? 'OKEY' : 'ХОРИГ'}</Badge>
            <span className="text-[11.5px] text-subtle">{r.approvalBy ?? ''}</span>
            <Button size="sm" variant={r.approved ? 'secondary' : 'primary'} onClick={() => void set(r, true)}>Зөвшөөрөх</Button>
            <Button size="sm" variant="danger" onClick={() => { setBlock(r); setNote(''); }}>Цуцлах</Button>
            <label className="flex items-center gap-1.5 text-[12.5px] font-semibold"><input type="checkbox" className="h-4 w-4" checked={r.trusted} onChange={() => void trust(r)} />Итгэмжлэх</label>
          </div>
        ))}
      </div>
      {block ? (
        <Modal open onClose={() => setBlock(null)} title={`ХОРИГ · ${block.name}`} footer={<><Button onClick={() => setBlock(null)}>Болих</Button><Button variant="danger" onClick={() => void set(block, false, note)}>ХОРИГ тавих</Button></>}>
          <label htmlFor="bnote" className="text-[13px] font-semibold text-muted">Шалтгаан (жишээ: өр 120,000₮)</label>
          <textarea id="bnote" data-autofocus rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2" />
        </Modal>
      ) : null}
    </Modal>
  );
}

// ───────────────────────── Гүйцэтгэл солих (Супер админ) ─────────────────────────

interface ModeRow { id: string; name: string; phone: string; mode: string; modeLabel: string; regionalRate: number | null; since: string | null; byName: string | null }
export function PayModeDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<{ regionalDefault: number; items: ModeRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const load = useCallback(async () => { try { setData(await api('/api/accounting/pay-modes')); setErr(null); } catch (e) { setErr(msg(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  const set = async (r: ModeRow, mode: string) => {
    setOk(null);
    try { const x = await api<{ message: string }>('/api/accounting/pay-modes', { method: 'POST', json: { driverId: r.id, mode, rate: rates[r.id] || undefined } }); setOk(x.message); await load(); } catch (e) { setErr(msg(e)); }
  };
  const items = (data?.items ?? []).filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()) || r.phone.includes(q));
  return (
    <Modal open onClose={onClose} size="xl" title="Гүйцэтгэл солих" subtitle="Тусгай: ≥91.5% → 5000₮, ≥86.4% → 4500₮ · Орон нутаг: тогтмол хөлс. Өнөөдрөөс хүчинтэй — өнгөрсөн өдрийн тооцоо өөрчлөгдөхгүй" footer={<Button onClick={onClose}>Хаах</Button>}>
      {err ? <Notice>{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Жолооч хайх" className="mb-2 h-10 w-full rounded-xl border border-line bg-surface px-3" aria-label="Жолооч хайх" />
      <div className="divide-y divide-line rounded-[14px] border border-line">
        {items.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <div className="min-w-[160px] flex-1"><b className="[overflow-wrap:anywhere]">{r.name}</b>
              <span className="block text-[12px] text-subtle">{r.modeLabel}{r.mode === 'REGIONAL' ? ` · ${money(r.regionalRate)}` : ''}{r.since ? ` · ${r.since}-аас · ${r.byName}` : ''}</span></div>
            {(['NORMAL', 'SPECIAL'] as const).map((m) => <button key={m} onClick={() => void set(r, m)} className={clsx('h-9 rounded-full border px-3 text-[12.5px] font-bold', r.mode === m ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>{m === 'NORMAL' ? 'Энгийн' : 'Тусгай'}</button>)}
            <input inputMode="numeric" value={rates[r.id] ?? (r.mode === 'REGIONAL' ? String(r.regionalRate ?? '') : '')} placeholder={String(data?.regionalDefault ?? 3000)}
              onChange={(e) => setRates({ ...rates, [r.id]: e.target.value.replace(/\D/g, '') })} className="h-9 w-[90px] rounded-lg border border-line bg-surface px-2 text-right text-[13px]" aria-label={`${r.name} орон нутгийн хөлс`} />
            <button onClick={() => void set(r, 'REGIONAL')} className={clsx('h-9 rounded-full border px-3 text-[12.5px] font-bold', r.mode === 'REGIONAL' ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>Орон нутаг</button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ───────────────────────── Төлбөр тооцооны бүртгэл (компанид өгөх өр) ─────────────────────────

const KINDS: [string, string][] = [['GOODS_NOT_RETURNED', 'Агуулахад бараа буцаагаагүй'], ['PRODUCT_NOT_DELIVERED', 'Барааг хүлээлгэж өгөөгүй'], ['ACCOUNTING_MISMATCH', 'Нягтлантай нийлээгүй'], ['OTHER', 'Бусад']];
interface DebtRow { id: number; kind: string; kindLabel: string; description: string; amount: number; status: string; createdAt: string; createdByName: string; resolvedAt: string | null; resolvedByName: string | null; resolvedNote: string | null; orderNumber: string | null; auto: boolean }
export interface Ledger { driver: { id: string; name: string; phone: string }; summary: { pending: number; pendingCount: number; resolved: number; resolvedCount: number }; pending: DebtRow[]; resolved: DebtRow[] }

export function LedgerList({ l, onResolve }: { l: Ledger; onResolve?: (d: DebtRow) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-[12px] border border-line bg-surface px-3 py-2"><div className="text-[11.5px] font-semibold text-subtle">Төлөгдөөгүй өр ({l.summary.pendingCount})</div><div className="text-[18px] font-extrabold text-bad-ink">{money(l.summary.pending)}</div></div>
        <div className="rounded-[12px] border border-line bg-surface px-3 py-2"><div className="text-[11.5px] font-semibold text-subtle">Хаагдсан ({l.summary.resolvedCount})</div><div className="text-[18px] font-extrabold text-ok-ink">{money(l.summary.resolved)}</div></div>
      </div>
      {[...l.pending, ...l.resolved].map((d) => (
        <div key={d.id} className={clsx('rounded-[12px] border px-3 py-2 text-[13px]', d.status === 'PENDING' ? 'border-bad/40 bg-bad-soft/30' : 'border-line bg-surface')}>
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="flex flex-wrap items-center gap-1.5"><Badge tone={d.status === 'PENDING' ? 'bad' : 'ok'}>{d.status === 'PENDING' ? 'Төлөгдөөгүй' : 'Хаагдсан'}</Badge><b>{d.kindLabel}</b>{d.auto ? <Badge tone="info">автомат</Badge> : null}</span><b className="whitespace-nowrap">{money(d.amount)}</b></div>
          <div className="mt-0.5 text-muted [overflow-wrap:anywhere]">{d.description}{d.orderNumber ? ` · №${d.orderNumber}` : ''}</div>
          <div className="text-[11.5px] text-subtle">{ubDateTime(d.createdAt)} · {d.createdByName}{d.resolvedAt ? ` → ${ubDateTime(d.resolvedAt)} · ${d.resolvedByName}: ${d.resolvedNote ?? ''}` : ''}</div>
          {d.status === 'PENDING' && onResolve ? <Button size="sm" className="mt-1" onClick={() => onResolve(d)}>Өр хасах</Button> : null}
        </div>
      ))}
      {!l.pending.length && !l.resolved.length ? <p className="py-6 text-center text-muted">Өр бүртгэгдээгүй байна</p> : null}
    </div>
  );
}

export function DebtLedgerDialog({ onClose }: { onClose: () => void }) {
  const [board, setBoard] = useState<{ items: { id: string; name: string; phone: string; pending: number; count: number }[]; total: number } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [add, setAdd] = useState(false);
  const [form, setForm] = useState({ kind: 'OTHER', description: '', amount: '', orderNumber: '' });
  const [resolve, setResolve] = useState<DebtRow | null>(null);
  const [note, setNote] = useState('');
  const [pay, setPay] = useState<'CASH' | 'BANK' | ''>('');
  const [busy, setBusy] = useState(false);
  const loadBoard = useCallback(async () => { try { setBoard(await api('/api/accounting/debts')); } catch (e) { setErr(msg(e)); } }, []);
  const loadLedger = useCallback(async (id: string) => { try { setLedger(await api(`/api/accounting/debts/${id}`)); setErr(null); } catch (e) { setErr(msg(e)); } }, []);
  useEffect(() => { void loadBoard(); }, [loadBoard]);
  useEffect(() => { if (sel) void loadLedger(sel); }, [sel, loadLedger]);
  const doAdd = async () => {
    setBusy(true); setErr(null);
    try { await api('/api/accounting/debts', { method: 'POST', json: { driverId: sel, ...form, amount: Number(form.amount) } }); setAdd(false); setForm({ kind: 'OTHER', description: '', amount: '', orderNumber: '' }); await loadLedger(sel!); await loadBoard(); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const doResolve = async () => {
    setBusy(true); setErr(null);
    try { await api(`/api/accounting/debts/entry/${resolve!.id}/resolve`, { method: 'POST', json: { note, ...(pay ? { payment: pay } : {}) } }); setResolve(null); setNote(''); setPay(''); await loadLedger(sel!); await loadBoard(); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const shortageNow = async () => { try { await api(`/api/accounting/debts/${sel}`, { method: 'POST' }); await loadLedger(sel!); await loadBoard(); } catch (e) { setErr(msg(e)); } };
  return (
    <Modal open onClose={onClose} size="xl" title={sel && ledger ? `${ledger.driver.name} — Өрийн бүртгэл` : 'Төлбөр тооцооны бүртгэл'}
      subtitle="Компанид өгөх өр. Жолоочийн хувийн «Өрийн дэвтэр» (үйлчлүүлэгчийн өр)-тэй холбоогүй. Буцаагаагүй бараа өдрийн эцэст автоматаар өр болж, буцаахад автоматаар хаагдана"
      footer={<>{sel ? <><Button onClick={() => { setSel(null); setLedger(null); }}>← Жолоочид</Button><Button onClick={() => void shortageNow()}>Дутуу бараа одоо бодох</Button><Button variant="primary" onClick={() => setAdd(true)}>Өр нэмэх</Button></> : null}<Button onClick={onClose}>Хаах</Button></>}>
      {err ? <Notice>{err}</Notice> : null}
      {!sel ? (
        <div className="divide-y divide-line rounded-[14px] border border-line">
          <div className="flex justify-between px-3 py-2 text-[13px] font-extrabold"><span>Нийт төлөгдөөгүй</span><span className="text-bad-ink">{money(board?.total ?? 0)}</span></div>
          {board?.items.map((d) => (
            <button key={d.id} onClick={() => setSel(d.id)} className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-surface2">
              <span className="min-w-0"><b className="[overflow-wrap:anywhere]">{d.name}</b><span className="block text-[12px] text-subtle">{d.phone}</span></span>
              {d.pending ? <span className="shrink-0 text-right"><b className="text-bad-ink">{money(d.pending)}</b><span className="block text-[11.5px] text-subtle">{d.count} бичлэг</span></span> : <span className="text-[12.5px] text-ok-ink">Өргүй</span>}
            </button>
          ))}
        </div>
      ) : ledger ? <LedgerList l={ledger} onResolve={(d) => { setResolve(d); setNote(''); }} /> : null}
      {add ? (
        <Modal open onClose={() => setAdd(false)} title="Өр нэмэх" footer={<><Button onClick={() => setAdd(false)}>Болих</Button><Button variant="primary" loading={busy} onClick={() => void doAdd()}>Нэмэх</Button></>}>
          <div className="flex flex-col gap-2">
            <label className="text-[13px] font-semibold text-muted" htmlFor="dk">Өрийн төрөл</label>
            <select id="dk" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className="h-11 rounded-xl border border-line bg-surface px-2">{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <label className="text-[13px] font-semibold text-muted" htmlFor="dd">Тайлбар</label>
            <textarea id="dd" data-autofocus rows={2} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="rounded-xl border border-line bg-surface px-3 py-2" placeholder="Өрийн дэлгэрэнгүй тайлбар" />
            <label className="text-[13px] font-semibold text-muted" htmlFor="da">Дүн (₮)</label>
            <input id="da" inputMode="numeric" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value.replace(/\D/g, '') })} className="h-11 rounded-xl border border-line bg-surface px-3" />
            <label className="text-[13px] font-semibold text-muted" htmlFor="dn">Захиалгын дугаар (заавал биш)</label>
            <input id="dn" inputMode="numeric" value={form.orderNumber} onChange={(e) => setForm({ ...form, orderNumber: e.target.value.replace(/\D/g, '') })} className="h-11 rounded-xl border border-line bg-surface px-3" />
          </div>
        </Modal>
      ) : null}
      {resolve ? (
        <Modal open onClose={() => setResolve(null)} title="Өр хасах" subtitle={`${resolve.kindLabel} · ${money(resolve.amount)}`} footer={<><Button onClick={() => setResolve(null)}>Болих</Button><Button variant="primary" loading={busy} disabled={resolve.kind === 'GOODS_NOT_RETURNED' && resolve.auto && !pay} onClick={() => void doResolve()}>Хасах</Button></>}>
          {resolve.kind === 'GOODS_NOT_RETURNED' && resolve.auto ? (
            <>
              <Notice tone="warn">Жолоочид байгаа барааны өр — зөвхөн МӨНГӨӨР (доор) эсвэл жолооч барааг агуулахад буцааж өгөхөд хаагдана. Мөнгө авахад бараа жолоочийн нэрээс хасагдана (зарагдсан).</Notice>
              <div className="mt-2 flex gap-2" role="radiogroup" aria-label="Төлбөр">
                {(['CASH', 'BANK'] as const).map((p) => <Button key={p} size="sm" variant={pay === p ? 'primary' : 'secondary'} aria-pressed={pay === p} onClick={() => setPay(p)}>{p === 'CASH' ? 'Бэлэн авсан' : 'Дансаар авсан'}</Button>)}
              </div>
            </>
          ) : null}
          <label htmlFor="rn" className="mt-2 block text-[13px] font-semibold text-muted">Шалтгаан (жишээ: бэлнээр төлсөн)</label>
          <textarea id="rn" data-autofocus rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2" />
        </Modal>
      ) : null}
    </Modal>
  );
}

// ───────────────────────── Цалингийн дүрэм (Супер админ) ─────────────────────────

interface Rules { rates: { high: number; mid: number; low: number }; regionalDefault: number; bigCount: number; big: { high: number; mid: number }; small: { high: number; mid: number }; special: { high: number; mid: number } }
export function SalaryRulesDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<{ today: string; current: Rules & { effectiveFrom: string | null }; defaults: Rules; canEdit: boolean; history: { id: number; effectiveFrom: string; rules: Rules; note: string | null; byName: string; createdAt: string }[] } | null>(null);
  const [r, setR] = useState<Rules | null>(null);
  const [from, setFrom] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { const d = await api<NonNullable<typeof data>>('/api/accounting/salary-rules'); setData(d); setR(d.current); setFrom(new Date(Date.now() + 8 * 3600_000 + 86_400_000).toISOString().slice(0, 10)); } catch (e) { setErr(msg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    setBusy(true); setErr(null); setOk(false);
    try { await api('/api/accounting/salary-rules', { method: 'POST', json: { effectiveFrom: from, rules: r, note } }); setOk(true); await load(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const num = (v: number, set: (n: number) => void, label: string, step = '1') => (
    <label className="flex flex-col gap-1 text-[12px] font-semibold text-muted">{label}
      <input type="number" step={step} value={v} onChange={(e) => set(Number(e.target.value))} className="h-10 rounded-lg border border-line bg-surface px-2 text-[14px] text-ink" /></label>
  );
  if (!r) return <Modal open onClose={onClose} title="Цалингийн дүрэм">{err ? <Notice>{err}</Notice> : null}</Modal>;
  const tier = (k: 'big' | 'small' | 'special', title: string) => (
    <div className="rounded-[12px] border border-line p-2.5"><div className="mb-1 text-[13px] font-bold">{title}</div>
      <div className="grid grid-cols-2 gap-2">{num(r[k].high, (n) => setR({ ...r, [k]: { ...r[k], high: n } }), `≥ % → ${money(r.rates.high)}`, '0.1')}{num(r[k].mid, (n) => setR({ ...r, [k]: { ...r[k], mid: n } }), `≥ % → ${money(r.rates.mid)}`, '0.1')}</div></div>
  );
  return (
    <Modal open onClose={onClose} size="xl" title="Цалингийн дүрэм (хөлс, гүйцэтгэлийн босго)" subtitle={`Одоо хүчинтэй: ${data?.current.effectiveFrom ?? 'анхны (хуучин ERP)'}. Шинэ дүрэм сонгосон өдрөөс хүчинтэй — өнгөрсөн өдрийн тооцоо өөрчлөгдөхгүй`}
      footer={<><Button onClick={onClose}>Хаах</Button>{data?.canEdit ? <Button variant="primary" loading={busy} onClick={() => void save()}>Хадгалах</Button> : null}</>}>
      <div className="flex flex-col gap-3">
        {err ? <Notice>{err}</Notice> : null}
        {ok ? <Notice tone="ok">Хадгалагдлаа — {from}-аас хүчинтэй</Notice> : null}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {num(r.rates.high, (n) => setR({ ...r, rates: { ...r.rates, high: n } }), 'Өндөр хөлс ₮')}
          {num(r.rates.mid, (n) => setR({ ...r, rates: { ...r.rates, mid: n } }), 'Дунд хөлс ₮')}
          {num(r.rates.low, (n) => setR({ ...r, rates: { ...r.rates, low: n } }), 'Бага хөлс ₮')}
          {num(r.regionalDefault, (n) => setR({ ...r, regionalDefault: n }), 'Орон нутаг (анхны) ₮')}
        </div>
        <div className="grid gap-2 sm:grid-cols-[160px_1fr]">{num(r.bigCount, (n) => setR({ ...r, bigCount: n }), 'Олон захиалгын босго')}<p className="self-end pb-2 text-[12.5px] text-muted">Тооцох захиалга (хүргэсэн + цуцалсан + маргааш) энэ тооноос их бол «олон захиалга»-ын босго хэрэглэнэ.</p></div>
        <div className="grid gap-2 lg:grid-cols-3">{tier('big', `${r.bigCount}+ захиалга / гараар засагдсан`)}{tier('small', `${r.bigCount}-аас цөөн`)}{tier('special', 'Тусгай гүйцэтгэл')}</div>
        {data?.canEdit ? (
          <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
            <label className="flex flex-col gap-1 text-[12px] font-semibold text-muted">Хэдэн өдрөөс<input type="date" min={data.today} value={from} onChange={(e) => setFrom(e.target.value)} className="h-10 rounded-lg border border-line bg-surface px-2 text-[14px] text-ink" /></label>
            <label className="flex flex-col gap-1 text-[12px] font-semibold text-muted">Тайлбар<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Жишээ: шатахууны үнэ өссөн" className="h-10 rounded-lg border border-line bg-surface px-2 text-[14px] text-ink" /></label>
          </div>
        ) : null}
        {data?.history.length ? (
          <div className="rounded-[12px] border border-line p-2.5 text-[12.5px]"><div className="mb-1 font-bold">Түүх</div>
            {data.history.map((h) => <div key={h.id} className="py-0.5 [overflow-wrap:anywhere]"><b>{h.effectiveFrom}</b>-аас: {money(h.rules.rates.high)} / {money(h.rules.rates.mid)} / {money(h.rules.rates.low)} · {h.byName}{h.note ? ` — ${h.note}` : ''}</div>)}
          </div>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => data && setR(data.defaults)}>Хуучин ERP-ийн утга (5000 / 4500 / 4000)</Button>
      </div>
    </Modal>
  );
}
