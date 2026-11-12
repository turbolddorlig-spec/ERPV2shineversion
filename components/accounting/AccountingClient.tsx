'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Badge } from '@/components/ui/Badge';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';
import { DebtLedgerDialog, OkeyDialog, PayModeDialog, SalaryRulesDialog } from './AccountingDialogs';

/**
 * Нягтлан бодох бүртгэл (Модуль 6, хуучин ERP-ийн хуудас шиг): өдөр = ПАДААНЫ өдөр (#83).
 * Картууд, жолооч бүрийн хураангуй (гүйцэтгэл ✏️, хөлс, цалин, хүлээн авах, «Тооцоо хийсэн», «Тооцоо нийлсэн»), жолоочийн дэлгэрэнгүй,
 * OKEY, Гүйцэтгэл солих (Супер админ), Төлбөр тооцооны бүртгэл, Цалингийн дүрэм.
 */
export interface Settlement {
  id: number; status: 'DRAFT' | 'PENDING' | 'COMPLETED'; cashAmount: number; bankAmount: number; debtAmount: number; expectedAmount: number;
  submittedAt: string | null; approvedAt: string | null; approvedByName: string | null;
  perfOverride: number | null; perfNote: string | null; perfByName: string | null; perfAt: string | null;
  accountingSettled: boolean; settledAt: string | null; settledByName: string | null;
}
export interface Day {
  driverId: string; driverName: string; date: string; handover: { id: number; number: string; status: string } | null;
  total: number; delivered: number; cancelled: number; excluded: number; postponed: number; out: number; notReceived: number; countable: number;
  deliveredAmount: number; prepaidAmount: number; prepaidCount: number; cancelledAmount: number; cash: number; bank: number; unpaid: number;
  partialCount: number; refusedAmount: number; perfCalc: number; perfOverride: number | null; perf: number; mode: 'NORMAL' | 'SPECIAL' | 'REGIONAL';
  regionalRate: number | null; rate: number; tier: string; salary: number; toReceive: number; extraSale: { count: number; amount: number };
  settlement: Settlement | null; locked: boolean;
}
interface Payment { id: number; kind: string; driverId: string; driverName: string; date: string; amount: number; note: string | null; approved: boolean; approvedByName: string | null; createdAt: string }
export interface RulesText { key: string; title: string; lines: string[] }
type Totals = Record<string, number> & { settled: { count: number; cash: number; bank: number; debt: number; total: number } };
interface Board { date: string; canManagePay: boolean; rulesText: RulesText[]; kpi: Totals; filteredTotals: Totals; items: Day[]; payments: Payment[]; approvals: { driverId: string; approved: boolean; note: string | null }[] }
interface DailyDebt { id: number; driverName: string; kindLabel: string; description: string; amount: number; createdAt: string; resolvedAt: string | null; resolvedNote: string | null }
interface Daily { created: DailyDebt[]; resolved: DailyDebt[]; createdTotal: number; resolvedTotal: number; createdCount?: number; resolvedCount?: number }

export const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const ubToday = (add = 0) => new Date(Date.now() + 8 * 3600_000 + add * 86_400_000).toISOString().slice(0, 10);
const shift = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const MODE_L: Record<string, string> = { NORMAL: 'Энгийн', SPECIAL: 'Тусгай', REGIONAL: 'Орон нутаг' };
export const TIER_L: Record<string, string> = { flat: '1 хүргэлт тогтмол', regional: 'Орон нутаг (тогтмол)', special: 'Тусгай', manual: 'Гараар засагдсан', big: '35+ захиалга', small: '35-аас цөөн' };
const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)}%`;

type TabK = 'todo' | 'none' | 'done' | 'all';
const stOf = (r: Day): Exclude<TabK, 'all'> => (r.settlement?.status === 'COMPLETED' ? 'done' : r.settlement?.status === 'PENDING' ? 'todo' : 'none');

export function AccountingClient() {
  const [date, setDate] = useState(ubToday());
  const [q, setQ] = useState('');
  const [prepaid, setPrepaid] = useState('');
  const [tab, setTab] = useState<TabK | null>(null);
  const [data, setData] = useState<Board | null>(null);
  const [daily, setDaily] = useState<Daily | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [dlg, setDlg] = useState<null | 'okey' | 'modes' | 'debts' | 'rules'>(null);
  const [menu, setMenu] = useState(false);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [perfFor, setPerfFor] = useState<Day | null>(null);
  const [approveFor, setApproveFor] = useState<Day | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ date, ...(prepaid ? { prepaid } : {}) });
      const [b, d] = await Promise.all([api<Board>(`/api/accounting?${qs}`), api<Daily>(`/api/accounting/debts?daily=${date}`)]);
      setData(b); setDaily(d); setErr(null);
    } catch (e) { setErr(msg(e)); }
  }, [date, prepaid]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setTab(null); }, [date]);

  const k = data?.kpi;
  const payBy = useMemo(() => {
    const m = new Map<string, Payment[]>();
    for (const p of data?.payments ?? []) { const a = m.get(p.driverId) ?? []; a.push(p); m.set(p.driverId, a); }
    return m;
  }, [data]);
  const approval = useMemo(() => new Map((data?.approvals ?? []).map((a) => [a.driverId, a])), [data]);
  const counts = useMemo(() => {
    const c = { todo: 0, none: 0, done: 0, all: data?.items.length ?? 0 };
    for (const r of data?.items ?? []) c[stOf(r)]++;
    return c;
  }, [data]);
  const activeTab: TabK = tab ?? (counts.todo ? 'todo' : 'all');
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.items ?? []).filter((r) => (activeTab === 'all' || stOf(r) === activeTab) && (!s || r.driverName.toLowerCase().includes(s) || (r.handover?.number ?? '').toLowerCase().includes(s)));
  }, [data, activeTab, q]);
  const pendingPays = (data?.payments ?? []).filter((p) => !p.approved).length;
  const advTotal = (data?.payments ?? []).filter((p) => p.kind === 'ADVANCE' && p.approved).reduce((s, p) => s + p.amount, 0);
  const extraTotal = (data?.payments ?? []).filter((p) => p.kind === 'EXTRA' && p.approved).reduce((s, p) => s + p.amount, 0);
  const donePct = counts.all ? Math.round((counts.done / counts.all) * 100) : 0;
  const quick = [[-1, 'Өчигдөр'], [0, 'Өнөөдөр']] as const;
  const TABS: [TabK, string, string][] = [['todo', 'Баталгаажуулах', 'bg-warn'], ['none', 'Илгээгээгүй', 'bg-subtle'], ['done', 'Нийлсэн', 'bg-ok'], ['all', 'Бүгд', 'bg-ink']];

  return (
    <div className="flex flex-col gap-4">
      {/* Гарчиг ба үйлдэл */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[24px] font-extrabold tracking-tight">Тооцоо</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setDlg('okey')}>OKEY</Button>
          <Link href={`/handover?date=${date}`} className="inline-flex h-9 items-center rounded-[11px] border border-line bg-surface px-3 text-[13px] font-semibold hover:bg-surface2">Падаан</Link>
          <div className="relative">
            <Button size="sm" onClick={() => setMenu(!menu)} aria-expanded={menu}>⋯ Бусад</Button>
            {menu ? (
              <div className="absolute right-0 z-20 mt-1 flex w-[230px] flex-col rounded-[12px] border border-line bg-surface p-1 shadow-card" onMouseLeave={() => setMenu(false)}>
                {([['debts', 'Төлбөр тооцооны бүртгэл'], ...(data?.canManagePay ? [['modes', 'Гүйцэтгэл солих'], ['rules', 'Цалингийн дүрэм']] : [])] as [typeof dlg, string][]).map(([kk, l]) => (
                  <button key={l} onClick={() => { setMenu(false); setDlg(kk); }} className="rounded-[9px] px-3 py-2 text-left text-[13.5px] font-semibold hover:bg-surface2">{l}</button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Өдөр */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-full border border-line bg-surface p-1">
          <button onClick={() => setDate(shift(date, -1))} className="h-8 w-8 rounded-full text-[17px] font-bold hover:bg-surface2" aria-label="Өмнөх өдөр">‹</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-8 bg-transparent px-1 text-[14px] font-semibold" aria-label="Огноо" />
          <button onClick={() => setDate(shift(date, 1))} className="h-8 w-8 rounded-full text-[17px] font-bold hover:bg-surface2" aria-label="Дараах өдөр">›</button>
        </div>
        {quick.map(([a, l]) => { const d = ubToday(a); return <button key={a} onClick={() => setDate(d)} className={clsx('h-10 rounded-full px-3.5 text-[13px] font-bold', date === d ? 'bg-ink text-on-ink' : 'text-muted hover:bg-surface2')}>{l}</button>; })}
        <span className="text-[12.5px] text-subtle">· падааны өдрөөр</span>
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {okMsg ? <Notice tone="ok">{okMsg}</Notice> : null}

      {/* Гол хураангуй */}
      {k ? (
        <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card sm:p-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-muted">Жолоочоос хүлээн авах</div>
              <div className="text-[34px] font-extrabold leading-tight tracking-tight">{money(k.toReceive)}</div>
              <div className="text-[13px] text-muted">Хүргэсэн {money(k.deliveredAmount)} − орон нутаг {money(k.prepaidAmount)} − цалин {money(k.salary)}</div>
            </div>
            <div className="w-full max-w-[340px]">
              <div className="flex items-baseline justify-between text-[13px]"><span className="font-semibold text-muted">Тооцоо нийлсэн</span><b className="text-[15px]">{counts.done} / {counts.all} жолооч</b></div>
              <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-surface2"><div className="h-full rounded-full bg-ok" style={{ width: `${donePct}%` }} /></div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 text-[12.5px] text-muted"><span>Нийлсэн {money(k.settled.total)}</span>{k.settled.debt ? <span className="text-bad-ink">өр {money(k.settled.debt)}</span> : null}</div>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {([['Захиалга', String(k.total), null], ['Хүргэсэн', String(k.delivered), 'ok'], ['Цуцласан', String(k.cancelled + k.excluded), 'bad'], ['Маргааш', String(k.postponed), 'warn'], ['Жолооч цалин', money(k.salary), null], ['Дуусаагүй', String(k.out + k.notReceived), k.out + k.notReceived ? 'info' : null]] as const).map(([l, v, t]) => (
              <div key={l} className="min-w-0 rounded-[12px] bg-surface2 px-3 py-2">
                <div className="text-[12px] font-semibold text-muted">{l}</div>
                <div className={clsx('truncate text-[18px] font-extrabold', t === 'ok' && 'text-ok-ink', t === 'bad' && 'text-bad-ink', t === 'warn' && 'text-warn', t === 'info' && 'text-info')}>{v}</div>
              </div>
            ))}
          </div>
          <button onClick={() => setMore(!more)} className="mt-3 text-[13px] font-semibold text-accent-ink">{more ? '▴ Дэлгэрэнгүйг хураах' : '▾ Дэлгэрэнгүй тооцоо, өр'}</button>
          {more ? (
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              <div className="rounded-[14px] border border-line p-3">
                <div className="mb-1 text-[13px] font-extrabold">Төлбөрийн задаргаа</div>
                <Row l="Бэлэн" v={money(k.cash)} /><Row l="Данс" v={money(k.bank)} /><Row l="Төлөөгүй (жолооч тушаана)" v={money(k.unpaid)} />
                <Row l={`Орон нутаг (${k.prepaidCount})`} v={money(k.prepaidAmount)} />
              </div>
              <div className="rounded-[14px] border border-line p-3">
                <div className="mb-1 text-[13px] font-extrabold">Тооцоо нийлсэн</div>
                <Row l="Бэлэн" v={money(k.settled.cash)} /><Row l="Данс" v={money(k.settled.bank)} /><Row l="Өр" v={money(k.settled.debt)} tone={k.settled.debt ? 'bad' : undefined} />
                <div className="mt-1 text-[12.5px] text-muted">Урьдчилгаа {money(advTotal)} · Нэмэлт бараа {money(extraTotal)}</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <DebtCard title="Өнөөдөр өр тавьсан" tone="bad" total={daily?.createdTotal ?? 0} count={daily?.createdCount} list={daily?.created ?? []} />
                <DebtCard title="Өнөөдөр өр төлсөн" tone="ok" total={daily?.resolvedTotal ?? 0} count={daily?.resolvedCount} list={daily?.resolved ?? []} resolved />
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Жолоочид */}
      <section className="overflow-hidden rounded-[20px] border border-line bg-surface shadow-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5 sm:px-4">
          <div className="flex max-w-full gap-1 overflow-x-auto" role="tablist">
            {TABS.map(([kk, l, dot]) => (
              <button key={kk} role="tab" aria-selected={activeTab === kk} onClick={() => setTab(kk)}
                className={clsx('flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-bold', activeTab === kk ? 'bg-ink text-on-ink' : 'text-muted hover:bg-surface2')}>
                {kk !== 'all' ? <span className={clsx('h-2 w-2 rounded-full', dot)} /> : null}{l}<span className={clsx('rounded-full px-1.5 text-[11.5px]', activeTab === kk ? 'bg-white/20' : 'bg-surface2')}>{counts[kk]}</span>
              </button>
            ))}
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
            {pendingPays ? <Badge tone="warn">Урьдчилгаа / нэмэлт бараа хүлээгдэж {pendingPays}</Badge> : null}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Жолооч хайх" className="h-9 min-w-0 flex-1 rounded-full sm:w-[160px] sm:flex-none border border-line bg-surface px-3 text-[13.5px]" aria-label="Жолооч хайх" />
            <select value={prepaid} onChange={(e) => setPrepaid(e.target.value)} className="h-9 rounded-full border border-line bg-surface px-2 text-[13px]" aria-label="Орон нутаг">
              <option value="">Бүгд</option><option value="yes">Орон нутагтай</option><option value="no">Орон нутаггүй</option>
            </select>
          </div>
        </div>
        {/* Компьютер: хүснэгт */}
        <div className="hidden md:block">
          <table className="w-full text-[13.5px]">
            <thead className="text-[12px] text-subtle"><tr className="border-b border-line">
              <th className="px-4 py-2.5 text-left font-semibold">Жолооч</th><th className="px-3 py-2.5 text-right font-semibold">Хүргэсэн</th><th className="px-3 py-2.5 text-right font-semibold">Гүйцэтгэл</th>
              <th className="px-3 py-2.5 text-right font-semibold">Цалин</th><th className="px-3 py-2.5 text-right font-semibold">Хүлээн авах</th><th className="px-4 py-2.5 text-left font-semibold">Төлөв</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => <DriverRow key={r.driverId} r={r} pays={payBy.get(r.driverId) ?? []} ap={approval.get(r.driverId)} onOpen={() => setOpen(r.driverId)} onPerf={() => setPerfFor(r)} onApprove={() => setApproveFor(r)} onDone={load} onErr={setErr} />)}
            </tbody>
          </table>
        </div>
        {/* Гар утас: карт */}
        <ul className="divide-y divide-line md:hidden">
          {rows.map((r) => <DriverCard key={r.driverId} r={r} pays={payBy.get(r.driverId) ?? []} onOpen={() => setOpen(r.driverId)} onApprove={() => setApproveFor(r)} onDone={load} onErr={setErr} />)}
        </ul>
        {data && !rows.length ? <p className="px-4 py-12 text-center text-muted">{activeTab === 'todo' ? 'Баталгаажуулах тооцоо алга 👍' : 'Жолооч алга'}</p> : null}
      </section>

      {open ? <DriverDrawer driverId={open} date={date} onClose={() => setOpen(null)} onChanged={load} onPerf={(d) => setPerfFor(d)} onApprove={(d) => setApproveFor(d)} /> : null}
      {perfFor ? <PerfDialog r={perfFor} onClose={() => setPerfFor(null)} onDone={async () => { setPerfFor(null); await load(); }} /> : null}
      {approveFor ? <ApproveDialog r={approveFor} onClose={() => setApproveFor(null)} onDone={async (m) => { setApproveFor(null); setOkMsg(m); await load(); }} /> : null}
      {dlg === 'okey' ? <OkeyDialog date={date} onClose={() => { setDlg(null); void load(); }} /> : null}
      {dlg === 'modes' ? <PayModeDialog onClose={() => { setDlg(null); void load(); }} /> : null}
      {dlg === 'debts' ? <DebtLedgerDialog onClose={() => { setDlg(null); void load(); }} /> : null}
      {dlg === 'rules' ? <SalaryRulesDialog onClose={() => { setDlg(null); void load(); }} /> : null}
    </div>
  );
}

export function Row({ l, v, strong, tone }: { l: string; v: string | number; strong?: boolean; tone?: 'bad' | 'ok' | 'warn' }) {
  return (
    <div className={clsx('flex items-baseline justify-between gap-3 py-0.5 text-[13px]', strong && 'mt-0.5 border-t border-line pt-1.5 text-[14.5px] font-extrabold')}>
      <span className="min-w-0 text-muted [overflow-wrap:anywhere]">{l}</span>
      <span className={clsx('shrink-0 whitespace-nowrap font-bold', tone === 'bad' && 'text-bad-ink', tone === 'ok' && 'text-ok-ink', tone === 'warn' && 'text-warn')}>{v}</span>
    </div>
  );
}

function DebtCard({ title, tone, total, list, resolved, count }: { title: string; tone: 'bad' | 'ok'; total: number; list: DailyDebt[]; resolved?: boolean; count?: number }) {
  const [more, setMore] = useState(false);
  return (
    <div className="min-w-0 rounded-[14px] border border-line p-3">
      <div className="text-[12px] font-bold text-subtle">{title}</div>
      <div className={clsx('text-[18px] font-extrabold', tone === 'bad' ? 'text-bad-ink' : 'text-ok-ink')}>{money(total)}</div>
      <div className="text-[12px] text-muted">{count ?? list.length} бичлэг{count && count > list.length ? ` (сүүлийн ${list.length}-г харуулав)` : ''}</div>
      {list.length ? <button onClick={() => setMore(!more)} className="mt-1 text-[12px] font-semibold text-accent-ink">{more ? 'Хураах' : 'Харах'}</button> : null}
      {more ? (
        <ul className="mt-1 max-h-[180px] space-y-1 overflow-y-auto text-[12px]">
          {list.map((d) => <li key={d.id} className="[overflow-wrap:anywhere]"><b>{d.driverName}</b> · {money(d.amount)}<span className="block text-subtle">{resolved ? d.resolvedNote : d.description}</span></li>)}
        </ul>
      ) : null}
    </div>
  );
}

/** Төлөв: тогтмол өнгө — улбар шар = таны хийх ажил, ногоон = дууссан, саарал = хүлээгдэж буй */
function StatusPill({ r }: { r: Day }) {
  const s = r.settlement;
  if (s?.status === 'COMPLETED') return <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-ok-ink"><span className="h-2 w-2 rounded-full bg-ok" />Нийлсэн{s.debtAmount ? <span className="font-semibold text-bad-ink">· өр {money(s.debtAmount)}</span> : null}</span>;
  if (s?.status === 'PENDING') return <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-warn"><span className="h-2 w-2 rounded-full bg-warn" />Илгээсэн</span>;
  const left = r.out + r.notReceived;
  return <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted"><span className="h-2 w-2 rounded-full bg-subtle" />{left ? `Дуусаагүй ${left}` : 'Илгээгээгүй'}</span>;
}

function DriverRow({ r, pays, ap, onOpen, onPerf, onApprove, onDone, onErr }: { r: Day; pays: Payment[]; ap?: { approved: boolean }; onOpen: () => void; onPerf: () => void; onApprove: () => void; onDone: () => void; onErr: (s: string) => void }) {
  const s = r.settlement;
  return (
    <tr className="border-b border-line align-top last:border-0 hover:bg-surface2">
      <td className="w-[30%] min-w-[220px] px-4 py-3">
        <button data-driver-open onClick={onOpen} className="text-left text-[14.5px] font-bold hover:text-accent-ink hover:underline [overflow-wrap:anywhere]">{r.driverName}</button>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-subtle">
          <span>{r.handover?.number ?? 'падаангүй'}</span>
          {r.mode !== 'NORMAL' ? <Badge tone="accent">{MODE_L[r.mode]}</Badge> : null}
          {ap && !ap.approved ? <Badge tone="bad">ХОРИГ</Badge> : null}
          {s?.accountingSettled ? <span title="Тооцоо хийсэн">✓ хийсэн</span> : null}
        </div>
      </td>
      <td className="px-3 py-3 text-right whitespace-nowrap">
        <b className="text-[14.5px]">{r.delivered}</b><span className="text-subtle"> / {r.total}</span>
        {r.cancelled + r.excluded + r.postponed ? <div className="text-[12px] text-subtle">{r.cancelled + r.excluded ? <span className="text-bad-ink">цуцл. {r.cancelled + r.excluded}</span> : null}{r.postponed ? <span className="text-warn"> · марг. {r.postponed}</span> : null}</div> : null}
      </td>
      <td className="px-3 py-3 text-right whitespace-nowrap">
        <button onClick={r.locked ? undefined : onPerf} disabled={r.locked} className={clsx('font-bold', !r.locked && 'hover:text-accent-ink')} title={r.locked ? '' : 'Гараар засах'}>{pct(r.perf)}{!r.locked ? <span className="ml-1 text-[11px] text-subtle">✏️</span> : null}</button>
        <div className="text-[12px] text-subtle">{r.perfOverride !== null ? <span className="text-warn">гараар (тооц. {pct(r.perfCalc)})</span> : `${money(r.rate)} / захиалга`}</div>
      </td>
      <td className="px-3 py-3 text-right whitespace-nowrap">{money(r.salary)}</td>
      <td className="px-3 py-3 text-right whitespace-nowrap text-[15.5px] font-extrabold">{money(r.toReceive)}</td>
      <td className="min-w-[200px] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><StatusPill r={r} />{s?.status === 'PENDING' ? <Button size="sm" variant="primary" onClick={onApprove}>Баталгаажуулах</Button> : null}</div>
        {s && s.status !== 'DRAFT' ? <div className="mt-0.5 text-[12px] text-subtle">Бэлэн {money(s.cashAmount)} · Данс {money(s.bankAmount)}{s.debtAmount ? ` · Өр ${money(s.debtAmount)}` : ''}</div> : null}
        {pays.map((p) => <PaymentLine key={p.id} p={p} onDone={onDone} onErr={onErr} />)}
      </td>
    </tr>
  );
}

function DriverCard({ r, pays, onOpen, onApprove, onDone, onErr }: { r: Day; pays: Payment[]; onOpen: () => void; onApprove: () => void; onDone: () => void; onErr: (s: string) => void }) {
  const s = r.settlement;
  return (
    <li className="px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <button data-driver-open onClick={onOpen} className="min-w-0 text-left"><b className="block text-[15px] [overflow-wrap:anywhere]">{r.driverName}</b><span className="text-[12px] text-subtle">{r.handover?.number ?? 'падаангүй'} · {r.delivered}/{r.total} хүргэсэн · {pct(r.perf)}</span></button>
        <div className="shrink-0 text-right"><div className="text-[16px] font-extrabold">{money(r.toReceive)}</div><div className="text-[11.5px] text-subtle">хүлээн авах</div></div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><StatusPill r={r} />{s?.status === 'PENDING' ? <Button size="sm" variant="primary" onClick={onApprove}>Баталгаажуулах</Button> : null}</div>
      {pays.map((p) => <PaymentLine key={p.id} p={p} onDone={onDone} onErr={onErr} />)}
    </li>
  );
}

function PaymentLine({ p, onDone, onErr }: { p: Payment; onDone: () => void; onErr: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  const set = async (approved: boolean) => { setBusy(true); try { await api(`/api/accounting/payments/${p.id}`, { method: 'POST', json: { approved } }); onDone(); } catch (e) { onErr(msg(e)); } finally { setBusy(false); } };
  return (
    <div className="mt-1.5 flex items-start justify-between gap-2 rounded-[10px] bg-surface2 px-2.5 py-1.5 text-[12.5px]">
      <span className="min-w-0"><b>{p.kind === 'ADVANCE' ? 'Урьдчилгаа' : 'Нэмэлт бараа'} {money(p.amount)}</b>{p.note ? <span className="block text-subtle [overflow-wrap:anywhere]">{p.note}</span> : null}</span>
      {p.approved ? <button disabled={busy} onClick={() => void set(false)} className="shrink-0 text-[12px] font-semibold text-ok-ink" title="Буцаах">✓ Зөвшөөрсөн</button>
        : <Button size="sm" variant="dark" loading={busy} className="!h-7 shrink-0 !px-2.5 !text-[12px]" onClick={() => void set(true)}>Зөвшөөрөх</Button>}
    </div>
  );
}

function PerfDialog({ r, onClose, onDone }: { r: Day; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState(r.perfOverride !== null ? String(r.perfOverride) : '');
  const [note, setNote] = useState(r.settlement?.perfNote ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (clear: boolean) => {
    setBusy(true); setErr(null);
    try { await api('/api/accounting/perf', { method: 'POST', json: { driverId: r.driverId, date: r.date, value: clear ? null : v, note } }); onDone(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Гүйцэтгэл гараар засах" subtitle={`${r.driverName} · ${r.date} — зөвхөн энэ өдөрт`}
      footer={<>{r.perfOverride !== null ? <Button variant="danger" loading={busy} onClick={() => void save(true)}>Тооцоолсон руу буцаах</Button> : null}<Button onClick={onClose}>Болих</Button><Button variant="primary" loading={busy} onClick={() => void save(false)}>Хадгалах</Button></>}>
      <div className="flex flex-col gap-3">
        <div className="rounded-xl bg-surface2 px-3 py-2 text-[13px] text-muted">Тооцоолсон: <b>{pct(r.perfCalc)}</b> ({r.delivered} хүргэсэн ÷ {r.countable} тооцох). Гараар засвал хөлс «35+»-ийн босгоор бодогдоно (тусгай / орон нутагт нөлөөлөхгүй).</div>
        <label className="text-[13px] font-semibold text-muted" htmlFor="perf">Гүйцэтгэл (0–100%)</label>
        <input id="perf" data-autofocus inputMode="decimal" value={v} onChange={(e) => setV(e.target.value.replace(/[^\d.]/g, ''))} className="h-11 rounded-xl border border-line bg-surface px-3 text-[16px]" />
        <label className="text-[13px] font-semibold text-muted" htmlFor="perfnote">Шалтгаан (заавал)</label>
        <textarea id="perfnote" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className="rounded-xl border border-line bg-surface px-3 py-2" placeholder="Жишээ: Үйлчлүүлэгч утсаа солисон — жолоочийн буруу биш" />
        {err ? <Notice>{err}</Notice> : null}
      </div>
    </Modal>
  );
}

function ApproveDialog({ r, onClose, onDone }: { r: Day; onClose: () => void; onDone: (m: string) => void }) {
  const s = r.settlement!;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await api(`/api/accounting/settlements/${s.id}/approve`, { method: 'POST' }); onDone(`${r.driverName}: тооцоо баталгаажлаа${s.debtAmount ? ` — ${money(s.debtAmount)} өрийн бүртгэлд орлоо` : ''}`); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Тооцоо нийлэх" subtitle={`${r.driverName} · ${r.date}`}
      footer={<><Button onClick={onClose}>Болих</Button><Button variant="primary" loading={busy} onClick={() => void go()}>Баталгаажуулах</Button></>}>
      <div className="flex flex-col gap-2">
        <Row l="Хүлээн авах дүн" v={money(r.toReceive)} strong />
        <Row l="Бэлэн" v={money(s.cashAmount)} /><Row l="Данс" v={money(s.bankAmount)} /><Row l="Өр" v={money(s.debtAmount)} tone={s.debtAmount ? 'bad' : undefined} />
        {s.debtAmount ? <Notice tone="warn">{money(s.debtAmount)} жолоочийн «Төлбөр тооцооны бүртгэл»-д өр болж орно.</Notice> : null}
        <Notice tone="info">Баталгаажуулсны дараа буцаах боломжгүй — энэ өдрийн тооцоо түгжигдэнэ.</Notice>
        {err ? <Notice>{err}</Notice> : null}
      </div>
    </Modal>
  );
}

// ───────────────────────── Жолоочийн дэлгэрэнгүй ─────────────────────────

interface DOrder {
  id: number; number: string; status: string; phone: string; total: number; originalTotal: number | null; prepaid: boolean; deliveryPayment: string | null;
  cancelReason: string | null; cancelNote: string | null; issueFault: string | null; postponed: boolean; deliveredAt: string | null; cancelledAt: string | null;
  province: string; district: string | null; addressDetail: string; deliveredByName: string | null; cancelledByName: string | null; refused: number; version: number;
  lines: { name: string; label: string; qty: number; refusedQty: number; unitPrice: number }[];
}
export interface Detail {
  day: Day; rulesText: RulesText[]; modeLabel: string; orders: DOrder[];
  extras: { id: number; kind: string; status: string; total: number; payment: string | null; createdAt: string; lines: { qty: number; unitPrice: number }[] }[];
  debts: { id: number; kind: string; description: string; amount: number; createdAt: string }[]; debtTotal: number; payments: Payment[];
}
const PAY_L: Record<string, string> = { CASH: 'Бэлэн', BANK: 'Данс', UNPAID: 'Төлөөгүй', PREPAID: 'Урьдчилж төлсөн' };
const FAULT_L: Record<string, string> = { OPERATOR: 'Опп', DRIVER: 'Жолооч', MARKETING: 'Маркетинг', WAREHOUSE: 'Агуулах' };

export function orderBadge(o: DOrder): { l: string; tone: 'ok' | 'bad' | 'warn' | 'info' | 'neutral' } {
  if (o.postponed) return { l: 'Маргааш', tone: 'warn' };
  if (o.status === 'DELIVERED') return { l: o.refused ? 'Хүргэсэн (хэсэгчилсэн)' : 'Хүргэсэн', tone: 'ok' };
  if (o.status === 'CANCELLED') return { l: o.cancelReason === 'ISSUE' && o.issueFault !== 'DRIVER' ? `Цуцласан · ${FAULT_L[o.issueFault ?? ''] ?? 'асуудал'} (тооцохгүй)` : 'Цуцласан', tone: 'bad' };
  if (o.status === 'OUT_FOR_DELIVERY') return { l: 'Хүргэлтэд', tone: 'info' };
  return { l: 'Хүлээн аваагүй', tone: 'neutral' };
}

export function DayPanels({ d }: { d: Detail }) {
  const r = d.day;
  const extraTake = d.extras.filter((x) => x.kind === 'EXTRA_TAKE' && x.status !== 'CANCELLED');
  const extraSale = d.extras.filter((x) => x.kind === 'EXTRA_SALE');
  const left = r.out + r.notReceived;
  const handoverOk = r.total === r.delivered + r.cancelled + r.excluded + r.postponed + left && !left;
  const s = r.settlement;
  return (
    <>
      {/* Гол тоо */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {([['Хүргэсэн', `${r.delivered} / ${r.total}`, r.cancelled + r.excluded || r.postponed ? `цуцл. ${r.cancelled + r.excluded} · марг. ${r.postponed}` : null], ['Гүйцэтгэл', pct(r.perf), `${money(r.rate)} / захиалга`], ['Цалин', money(r.salary), null], ['Хүлээн авах', money(r.toReceive), null]] as const).map(([l, v, sub], i) => (
          <div key={l} className={clsx('min-w-0 rounded-[14px] px-3 py-2.5', i === 3 ? 'bg-ink text-on-ink' : 'bg-surface2')}>
            <div className={clsx('text-[12px] font-semibold', i === 3 ? 'opacity-75' : 'text-muted')}>{l}</div>
            <div className="truncate text-[19px] font-extrabold">{v}</div>
            {sub ? <div className="truncate text-[11.5px] text-subtle">{sub}</div> : null}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {r.handover ? <Badge tone={handoverOk ? 'ok' : 'warn'}>{handoverOk ? `✓ Падаан таарсан · ${r.handover.number} · ${r.total} захиалга` : `${r.handover.number}: дуусаагүй ${left}`}</Badge> : <Badge>Падаангүй</Badge>}
        {r.partialCount ? <Badge tone="warn">Хэсэгчилсэн {r.partialCount} · болиулсан {money(r.refusedAmount)}</Badge> : null}
        {extraSale.length ? <Badge tone="warn">Нэмэлт бараа зарсан {money(r.extraSale.amount)} · тооцоонд орохгүй</Badge> : null}
        {extraTake.length ? <Badge tone="info">Нэмэлт бараа авсан {extraTake.reduce((n, x) => n + x.lines.reduce((m, l) => m + l.qty, 0), 0)}ш</Badge> : null}
        {d.debtTotal ? <Badge tone="bad">Нээлттэй өр {money(d.debtTotal)}</Badge> : null}
        {r.locked ? <Badge tone="ok">🔒 Баталгаажсан</Badge> : null}
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-[14px] border border-line p-3">
          <div className="mb-1 text-[13px] font-extrabold">Мөнгө</div>
          <Row l={`Хүргэсэн дүн (${r.delivered})`} v={money(r.deliveredAmount)} />
          <Row l={`− Орон нутаг (${r.prepaidCount})`} v={money(r.prepaidAmount)} />
          <Row l={`− Цалин (${r.delivered} × ${money(r.rate)})`} v={money(r.salary)} />
          <Row l="= Хүлээн авах" v={money(r.toReceive)} strong />
        </div>
        <div className="rounded-[14px] border border-line p-3">
          <div className="mb-1 text-[13px] font-extrabold">Үйлчлүүлэгчийн төлбөр</div>
          <Row l="Бэлэн" v={money(r.cash)} /><Row l="Данс" v={money(r.bank)} /><Row l="Төлөөгүй (жолооч тушаана)" v={money(r.unpaid)} tone={r.unpaid ? 'warn' : undefined} />
          {s && s.status !== 'DRAFT' ? <div className="mt-1.5 rounded-[10px] bg-surface2 px-2.5 py-1.5 text-[12.5px]"><b>{s.status === 'COMPLETED' ? 'Нийлсэн' : 'Жолооч илгээсэн'}:</b> Бэлэн {money(s.cashAmount)} · Данс {money(s.bankAmount)} · Өр {money(s.debtAmount)}</div> : null}
        </div>
        <div className="rounded-[14px] border border-line p-3">
          <div className="mb-1 text-[13px] font-extrabold">Гүйцэтгэл</div>
          <Row l="Хүргэсэн" v={r.delivered} /><Row l="Цуцласан + Маргааш" v={r.cancelled + r.postponed} />
          {r.excluded ? <Row l="Тооцохгүй (бусдын алдаа)" v={r.excluded} /> : null}
          <Row l="Гүйцэтгэл" v={r.perfOverride !== null ? `${pct(r.perfCalc)} → ${pct(r.perfOverride)}` : pct(r.perf)} strong />
          <div className="mt-0.5 text-[12px] text-subtle">{TIER_L[r.tier]} · {money(r.rate)} / захиалга</div>
          <details className="mt-1 text-[12px] text-muted"><summary className="cursor-pointer font-semibold">Хөлсний дүрэм</summary>
            {d.rulesText.map((t) => <div key={t.key} className={clsx('mt-1 rounded-lg px-2 py-1', (t.key === r.tier || (t.key === 'big' && r.tier === 'manual')) && 'bg-accent-soft text-accent-ink')}><b>{t.title}</b>: {t.lines.join(' · ')}</div>)}
          </details>
        </div>
      </div>
    </>
  );
}

function DriverDrawer({ driverId, date, onClose, onChanged, onPerf, onApprove }: { driverId: string; date: string; onClose: () => void; onChanged: () => void; onPerf: (d: Day) => void; onApprove: (d: Day) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toggle, setToggle] = useState<DOrder | null>(null);
  const load = useCallback(async () => { try { setD(await api(`/api/accounting/driver?driverId=${driverId}&date=${date}`)); setErr(null); } catch (e) { setErr(msg(e)); } }, [driverId, date]);
  useEffect(() => { void load(); }, [load]);
  const r = d?.day;
  const markSettled = async () => { if (!r) return; try { await api('/api/accounting/settled', { method: 'POST', json: { driverId, date, value: !r.settlement?.accountingSettled } }); await load(); onChanged(); } catch (e) { setErr(msg(e)); } };
  return (
    <Modal open onClose={onClose} size="xl" title={r ? r.driverName : 'Жолооч'} subtitle={r ? `${date} · ${d?.modeLabel} гүйцэтгэл${r.handover ? ` · ${r.handover.number}` : ''}` : date}
      footer={<>
        {r ? <label className="mr-auto flex items-center gap-2 text-[13px] font-semibold"><input type="checkbox" className="h-5 w-5" checked={!!r.settlement?.accountingSettled} onChange={() => void markSettled()} />Тооцоо хийсэн</label> : null}
        {r && !r.locked ? <Button onClick={() => onPerf(r)}>✏️ Гүйцэтгэл засах</Button> : null}
        {r?.settlement?.status === 'PENDING' ? <Button variant="primary" onClick={() => onApprove(r)}>Баталгаажуулах</Button> : null}
        <Button onClick={onClose}>Хаах</Button></>}>
      {err ? <Notice>{err}</Notice> : null}
      {d && r ? (
        <div className="flex flex-col gap-3">
          <DayPanels d={d} />
          {d.debts.length ? (
            <div className="rounded-[14px] border border-bad-soft bg-bad-soft p-3 text-[12.5px]">
              <div className="mb-1 text-[13px] font-extrabold text-bad-ink">Нээлттэй өр (компанид) · {money(d.debtTotal)}</div>
              {d.debts.map((x) => <div key={x.id} className="flex justify-between gap-2 py-0.5"><span className="min-w-0 [overflow-wrap:anywhere]">{x.description}</span><b className="shrink-0 text-bad-ink">{money(x.amount)}</b></div>)}
            </div>
          ) : null}
          <div className="text-[13px] font-extrabold">Падааны захиалга ({d.orders.length})</div>
          <ul className="divide-y divide-line rounded-[14px] border border-line">
            {d.orders.map((o) => {
              const b = orderBadge(o);
              const canToggle = !r.locked && !o.postponed && ['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'].includes(o.status);
              return (
                <li key={o.id} className="grid gap-x-4 gap-y-1 px-3 py-2.5 text-[13px] sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_auto]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><Link href={`/orders?q=${o.number}`} className="font-bold hover:underline">№{o.number}</Link><Badge tone={b.tone}>{b.l}</Badge>{o.prepaid ? <Badge tone="accent">Орон нутаг</Badge> : o.deliveryPayment ? <span className="text-[12px] text-subtle">{PAY_L[o.deliveryPayment]}</span> : null}</div>
                    <div className="text-subtle [overflow-wrap:anywhere]">{o.phone} · {[o.district, o.addressDetail].filter(Boolean).join(', ')}</div>
                    {o.cancelNote ? <div className="text-[12px] text-subtle [overflow-wrap:anywhere]">«{o.cancelNote}»</div> : null}
                  </div>
                  <div className="min-w-0 text-[12.5px] [overflow-wrap:anywhere]">{o.lines.map((l, i) => <span key={i} className="block">{l.name}{l.label ? ` · ${l.label}` : ''} ×{l.qty}{l.refusedQty ? <b className="text-warn"> (болиулсан {l.refusedQty})</b> : null}</span>)}</div>
                  <div className="flex items-start justify-between gap-3 sm:flex-col sm:items-end">
                    <div className="text-right"><b className="whitespace-nowrap">{money(o.total)}</b>{o.originalTotal !== null && o.originalTotal !== o.total ? <span className="block text-[11px] text-subtle line-through">{money(o.originalTotal)}</span> : null}</div>
                    {canToggle ? <Button size="sm" variant="ghost" onClick={() => setToggle(o)}>Төлөв солих</Button> : null}
                  </div>
                </li>
              );
            })}
            {!d.orders.length ? <li className="px-4 py-6 text-center text-muted">Падаанд захиалга алга</li> : null}
          </ul>
        </div>
      ) : null}
      {toggle ? <ToggleDialog o={toggle} onClose={() => setToggle(null)} onDone={async () => { setToggle(null); await load(); onChanged(); }} /> : null}
    </Modal>
  );
}

function ToggleDialog({ o, onClose, onDone }: { o: DOrder; onClose: () => void; onDone: () => void }) {
  const targets = o.status === 'OUT_FOR_DELIVERY' ? ['DELIVERED', 'CANCELLED'] : o.status === 'DELIVERED' ? ['CANCELLED'] : ['DELIVERED'];
  const [target, setTarget] = useState(targets[0]!);
  const [payment, setPayment] = useState('CASH');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await api(`/api/accounting/orders/${o.id}/status`, { method: 'POST', json: { target, payment, note, version: o.version } }); onDone(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Төлөв солих · №${o.number}`} subtitle="Жолоочийн нэрийн өмнөөс — бараа журналаар зөв хөдөлнө, захиалга энэ падааны өдөрт үлдэнэ"
      footer={<><Button onClick={onClose}>Болих</Button><Button variant="primary" loading={busy} onClick={() => void go()}>Солих</Button></>}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">{targets.map((t) => <button key={t} onClick={() => setTarget(t)} className={clsx('h-10 rounded-full border px-4 text-[13.5px] font-bold', target === t ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>{t === 'DELIVERED' ? 'Хүргэсэн' : 'Цуцласан'}</button>)}</div>
        {target === 'DELIVERED' && !o.prepaid ? (
          <div className="flex flex-wrap gap-2">{['CASH', 'BANK', 'UNPAID'].map((p) => <button key={p} onClick={() => setPayment(p)} className={clsx('h-9 rounded-full border px-3 text-[13px] font-semibold', payment === p ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line bg-surface')}>{PAY_L[p]}</button>)}</div>
        ) : null}
        {o.status === 'CANCELLED' ? <p className="text-[12.5px] text-muted">Бараа жолоочид (агуулахад буцаагаагүй) байх ёстой.</p> : null}
        <label htmlFor="tnote" className="text-[13px] font-semibold text-muted">Шалтгаан (заавал)</label>
        <textarea id="tnote" data-autofocus rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className="rounded-xl border border-line bg-surface px-3 py-2" />
        {err ? <Notice>{err}</Notice> : null}
      </div>
    </Modal>
  );
}
