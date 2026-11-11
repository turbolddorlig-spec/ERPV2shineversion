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
interface Daily { created: DailyDebt[]; resolved: DailyDebt[]; createdTotal: number; resolvedTotal: number }

export const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const ubToday = (add = 0) => new Date(Date.now() + 8 * 3600_000 + add * 86_400_000).toISOString().slice(0, 10);
const shift = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const MODE_L: Record<string, string> = { NORMAL: 'Энгийн', SPECIAL: 'Тусгай', REGIONAL: 'Орон нутаг' };
export const TIER_L: Record<string, string> = { regional: 'Орон нутаг (тогтмол)', special: 'Тусгай', manual: 'Гараар засагдсан', big: '35+ захиалга', small: '35-аас цөөн' };
const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)}%`;

export function AccountingClient() {
  const [date, setDate] = useState(ubToday());
  const [driverId, setDriverId] = useState('');
  const [status, setStatus] = useState('');
  const [prepaid, setPrepaid] = useState('');
  const [data, setData] = useState<Board | null>(null);
  const [daily, setDaily] = useState<Daily | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [dlg, setDlg] = useState<null | 'okey' | 'modes' | 'debts' | 'rules'>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [perfFor, setPerfFor] = useState<Day | null>(null);
  const [approveFor, setApproveFor] = useState<Day | null>(null);
  const [allDrivers, setAllDrivers] = useState<{ id: string; name: string }[]>([]);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ date, ...(driverId ? { driverId } : {}), ...(status ? { status } : {}), ...(prepaid ? { prepaid } : {}) });
      const [b, d] = await Promise.all([api<Board>(`/api/accounting?${q}`), api<Daily>(`/api/accounting/debts?daily=${date}`)]);
      setData(b); setDaily(d); setErr(null);
      if (!driverId && !status && !prepaid) setAllDrivers(b.items.map((i) => ({ id: i.driverId, name: i.driverName })));
    } catch (e) { setErr(msg(e)); }
  }, [date, driverId, status, prepaid]);
  useEffect(() => { void load(); }, [load]);

  const toggleSettled = async (r: Day) => {
    try { await api('/api/accounting/settled', { method: 'POST', json: { driverId: r.driverId, date, value: !r.settlement?.accountingSettled } }); await load(); } catch (e) { setErr(msg(e)); }
  };
  const k = data?.kpi; const ft = data?.filteredTotals;
  const payBy = useMemo(() => {
    const m = new Map<string, Payment[]>();
    for (const p of data?.payments ?? []) { const a = m.get(p.driverId) ?? []; a.push(p); m.set(p.driverId, a); }
    return m;
  }, [data]);
  const approval = useMemo(() => new Map((data?.approvals ?? []).map((a) => [a.driverId, a])), [data]);
  const advTotal = (data?.payments ?? []).filter((p) => p.kind === 'ADVANCE' && p.approved).reduce((s, p) => s + p.amount, 0);
  const extraTotal = (data?.payments ?? []).filter((p) => p.kind === 'EXTRA' && p.approved).reduce((s, p) => s + p.amount, 0);
  const th = 'px-2.5 py-2 text-right font-bold whitespace-nowrap';
  const quick = [[-3, null], [-2, null], [-1, 'Өчигдөр'], [0, 'Өнөөдөр'], [1, 'Маргааш']] as const;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[24px] font-extrabold tracking-tight">Нягтлан бодох бүртгэл</h1>
          <p className="text-[13.5px] text-muted">Өдөр = падааны өдөр: тухайн өдрийн падаанд туссан захиалга бүр энэ өдрийн тооцоонд үлдэнэ</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setDlg('okey')}>OKEY</Button>
          {data?.canManagePay ? <Button size="sm" onClick={() => setDlg('modes')}>Гүйцэтгэл солих</Button> : null}
          {data?.canManagePay ? <Button size="sm" onClick={() => setDlg('rules')}>Цалингийн дүрэм</Button> : null}
          <Button size="sm" onClick={() => setDlg('debts')}>Төлбөр тооцооны бүртгэл</Button>
          <Link href={`/handover?date=${date}`} className="inline-flex h-9 items-center rounded-[11px] border border-line bg-surface px-3 text-[13px] font-semibold hover:bg-surface2">Падаан</Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setDate(shift(date, -1))} className="h-10 w-10 rounded-full border border-line bg-surface text-[18px] font-bold" aria-label="Өмнөх өдөр">‹</button>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-10 rounded-[10px] border border-line bg-surface px-2 text-[14px]" aria-label="Огноо" />
        <button onClick={() => setDate(shift(date, 1))} className="h-10 w-10 rounded-full border border-line bg-surface text-[18px] font-bold" aria-label="Дараах өдөр">›</button>
        {quick.map(([a, l]) => { const d = ubToday(a); return <button key={a} onClick={() => setDate(d)} className={clsx('h-10 rounded-full border px-3 text-[13px] font-bold', date === d ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>{l ?? d.slice(5).replace('-', '.')}</button>; })}
        <div className="ml-auto flex flex-wrap gap-2">
          <select value={driverId} onChange={(e) => setDriverId(e.target.value)} className="h-10 max-w-[200px] rounded-[10px] border border-line bg-surface px-2 text-[13.5px]" aria-label="Жолооч">
            <option value="">Бүх жолооч</option>{allDrivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-10 rounded-[10px] border border-line bg-surface px-2 text-[13.5px]" aria-label="Төлөв">
            <option value="">Бүх төлөв</option><option value="COMPLETED">Тооцоо нийлсэн</option><option value="PENDING">Хүсэлт явуулсан</option><option value="NONE">Огт явуулаагүй</option>
          </select>
          <select value={prepaid} onChange={(e) => setPrepaid(e.target.value)} className="h-10 rounded-[10px] border border-line bg-surface px-2 text-[13.5px]" aria-label="Орон нутаг">
            <option value="">Орон нутаг: бүгд</option><option value="yes">Орон нутагтай</option><option value="no">Орон нутаггүй</option>
          </select>
        </div>
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {okMsg ? <Notice tone="ok">{okMsg}</Notice> : null}

      {k ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {([
              ['Нийт захиалга', k.total, `${k.drivers} жолооч`],
              ['Хүргэсэн', k.delivered, money(k.deliveredAmount)],
              ['Цуцласан', k.cancelled + k.excluded, `маргааш ${k.postponed}${k.excluded ? ` · тооцохгүй ${k.excluded}` : ''}`],
              ['Орон нутаг', k.prepaidCount, money(k.prepaidAmount)],
              ['Жолооч цалин', money(k.salary), null],
              ['Хүлээн авах дүн', money(k.toReceive), k.out + k.notReceived ? `дуусаагүй ${k.out + k.notReceived}` : null],
            ] as const).map(([l, v, s]) => (
              <div key={l} className="min-w-0 rounded-[14px] border border-line bg-surface px-3 py-2.5">
                <div className="text-[11.5px] font-semibold text-subtle">{l}</div>
                <div className="truncate text-[19px] font-extrabold" title={String(v)}>{v}</div>
                {s ? <div className="truncate text-[12px] text-muted" title={String(s)}>{s}</div> : null}
              </div>
            ))}
          </div>
          <div className="grid gap-2 lg:grid-cols-3">
            <div className="rounded-[14px] border border-line bg-surface p-3">
              <div className="mb-1.5 text-[13px] font-extrabold">Тооцооны задаргаа (нийт)</div>
              <Row l="Хүргэсэн дүн" v={money(k.deliveredAmount)} />
              <Row l="− Орон нутаг (урьдчилж төлсөн)" v={money(k.prepaidAmount)} />
              <Row l="− Жолоочийн цалин" v={money(k.salary)} />
              <Row l="= Хүлээн авах дүн" v={money(k.toReceive)} strong />
              <div className="mt-1.5 border-t border-line pt-1.5 text-[12.5px] text-muted">Бэлэн {money(k.cash)} · Данс {money(k.bank)} · Төлөөгүй {money(k.unpaid)} <span className="text-subtle">(жолооч тушаана)</span></div>
            </div>
            <div className="rounded-[14px] border border-line bg-surface p-3">
              <div className="mb-1.5 text-[13px] font-extrabold">Тооцоо нийлсэн</div>
              <Row l="Бэлэн" v={money(k.settled.cash)} /><Row l="Дансаар" v={money(k.settled.bank)} /><Row l="Өр" v={money(k.settled.debt)} />
              <Row l="Нийт" v={money(k.settled.total)} strong />
              <div className="mt-1.5 border-t border-line pt-1.5 text-[12.5px] text-muted">Урьдчилгаа {money(advTotal)} · Нэмэлт барааны тооцоо {money(extraTotal)}</div>
              <div className="mt-1 flex flex-wrap gap-1.5 text-[12px]"><Badge tone="ok">нийлсэн {k.settled.count}</Badge><Badge tone="warn">хүсэлт {k.pendingCount}</Badge><Badge>огт явуулаагүй {k.noneCount}</Badge></div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <DebtCard title="Өнөөдөр өр тавьсан" tone="bad" total={daily?.createdTotal ?? 0} list={daily?.created ?? []} />
              <DebtCard title="Өнөөдөр өр төлсөн" tone="ok" total={daily?.resolvedTotal ?? 0} list={daily?.resolved ?? []} resolved />
            </div>
          </div>
        </>
      ) : null}

      <div className="overflow-hidden rounded-[16px] border border-line bg-surface shadow-card">
        <div className="border-b border-line px-4 py-2.5 text-[14px] font-extrabold">Жолооч бүрийн хураангуй</div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1320px] text-[13px]">
            <thead className="bg-surface2 text-[12px] text-muted"><tr>
              <th className="px-3 py-2 text-left font-bold">Жолооч</th><th className={th}>Нийт</th><th className={th}>Хүргэсэн</th><th className={th}>Хүргэлтэд</th><th className={th}>Цуцласан</th>
              <th className={th}>Гүйцэтгэл</th><th className={th}>Нэг захиалга</th><th className={th}>Дүн</th><th className={th}>Цалин</th><th className={th}>Хүлээн авах</th>
              <th className="px-2.5 py-2 text-center font-bold">Тооцоо хийсэн</th><th className="px-3 py-2 text-left font-bold">Тооцоо нийлсэн</th>
            </tr></thead>
            <tbody className="divide-y divide-line">
              {data?.items.map((r) => {
                const s = r.settlement; const pays = payBy.get(r.driverId) ?? []; const ap = approval.get(r.driverId);
                return (
                  <tr key={r.driverId} className="align-top hover:bg-surface2/50">
                    <td className="max-w-[230px] px-3 py-2">
                      <button onClick={() => setOpen(r.driverId)} className="text-left font-bold text-accent-ink underline decoration-dotted [overflow-wrap:anywhere]">{r.driverName}</button>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {r.mode !== 'NORMAL' ? <Badge tone="accent">{MODE_L[r.mode]}{r.mode === 'REGIONAL' ? ` ${money(r.rate)}` : ''}</Badge> : null}
                        {r.handover ? <span className="text-[11.5px] text-subtle">{r.handover.number}</span> : <span className="text-[11.5px] text-subtle">падаангүй</span>}
                        {ap ? <Badge tone={ap.approved ? 'ok' : 'bad'}>{ap.approved ? 'OKEY' : 'ХОРИГ'}</Badge> : null}
                      </div>
                    </td>
                    <td className="px-2.5 py-2 text-right">{r.total}</td>
                    <td className="px-2.5 py-2 text-right font-bold text-ok-ink">{r.delivered}{r.partialCount ? <span className="block text-[11px] font-semibold text-warn">хэсэгчилсэн {r.partialCount}</span> : null}</td>
                    <td className={clsx('px-2.5 py-2 text-right', r.out + r.notReceived ? 'font-bold text-info' : 'text-subtle')}>{r.out + r.notReceived || ''}</td>
                    <td className="px-2.5 py-2 text-right text-bad-ink">{r.cancelled + r.excluded || ''}{r.postponed ? <span className="block text-[11px] text-warn">маргааш {r.postponed}</span> : null}{r.excluded ? <span className="block text-[11px] text-subtle">тооцохгүй {r.excluded}</span> : null}</td>
                    <td className="px-2.5 py-2 text-right">
                      <span className="font-bold">{pct(r.perf)}</span>
                      {r.perfOverride !== null ? <span className="block text-[11px] text-warn" title={r.settlement?.perfNote ?? ''}>Гараар засагдсан {pct(r.perfCalc)} → {pct(r.perfOverride)}</span> : null}
                      {!r.locked ? <button onClick={() => setPerfFor(r)} className="block w-full text-right text-[11.5px] font-semibold text-accent-ink">✏️ Засах</button> : null}
                    </td>
                    <td className="px-2.5 py-2 text-right whitespace-nowrap">{money(r.rate)}<span className="block text-[11px] text-subtle">{TIER_L[r.tier]}</span></td>
                    <td className="px-2.5 py-2 text-right whitespace-nowrap">{money(r.deliveredAmount)}{r.prepaidAmount ? <span className="block text-[11px] text-subtle">орон нутаг {money(r.prepaidAmount)}</span> : null}</td>
                    <td className="px-2.5 py-2 text-right whitespace-nowrap">{money(r.salary)}</td>
                    <td className="px-2.5 py-2 text-right font-extrabold whitespace-nowrap">{money(r.toReceive)}</td>
                    <td className="px-2.5 py-2 text-center">
                      <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={!!s?.accountingSettled} onChange={() => void toggleSettled(r)} aria-label={`${r.driverName} тооцоо хийсэн`} title={s?.settledByName ? `${s.settledByName} · ${ubDateTime(s.settledAt)}` : ''} />
                    </td>
                    <td className="min-w-[220px] px-3 py-2">
                      <SettleCell r={r} onApprove={() => setApproveFor(r)} />
                      {pays.map((p) => <PaymentLine key={p.id} p={p} onDone={load} onErr={setErr} />)}
                    </td>
                  </tr>
                );
              })}
              {ft && data && data.items.length > 1 ? (
                <tr className="bg-surface2 font-extrabold">
                  <td className="px-3 py-2">НИЙТ ДҮНГЭЭР</td><td className="px-2.5 py-2 text-right">{ft.total}</td><td className="px-2.5 py-2 text-right">{ft.delivered}</td><td className="px-2.5 py-2 text-right">{ft.out + ft.notReceived || ''}</td>
                  <td className="px-2.5 py-2 text-right">{ft.cancelled + ft.excluded}</td><td /><td /><td className="px-2.5 py-2 text-right whitespace-nowrap">{money(ft.deliveredAmount)}</td>
                  <td className="px-2.5 py-2 text-right whitespace-nowrap">{money(ft.salary)}</td><td className="px-2.5 py-2 text-right whitespace-nowrap">{money(ft.toReceive)}</td><td /><td className="px-3 py-2 whitespace-nowrap">{money(ft.settled.total)}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {data && !data.items.length ? <p className="px-4 py-10 text-center text-muted">Энэ өдөр падаан алга</p> : null}
      </div>

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
    <div className={clsx('flex items-baseline justify-between gap-3 py-0.5 text-[13px]', strong && 'border-t border-line pt-1 text-[14.5px] font-extrabold')}>
      <span className="min-w-0 text-muted [overflow-wrap:anywhere]">{l}</span>
      <span className={clsx('shrink-0 whitespace-nowrap font-bold', tone === 'bad' && 'text-bad-ink', tone === 'ok' && 'text-ok-ink', tone === 'warn' && 'text-warn')}>{v}</span>
    </div>
  );
}

function DebtCard({ title, tone, total, list, resolved }: { title: string; tone: 'bad' | 'ok'; total: number; list: DailyDebt[]; resolved?: boolean }) {
  const [more, setMore] = useState(false);
  return (
    <div className="min-w-0 rounded-[14px] border border-line bg-surface p-3">
      <div className="text-[12px] font-bold text-subtle">{title}</div>
      <div className={clsx('text-[18px] font-extrabold', tone === 'bad' ? 'text-bad-ink' : 'text-ok-ink')}>{money(total)}</div>
      <div className="text-[12px] text-muted">{list.length} бичлэг</div>
      {list.length ? <button onClick={() => setMore(!more)} className="mt-1 text-[12px] font-semibold text-accent-ink">{more ? 'Хураах' : 'Харах'}</button> : null}
      {more ? (
        <ul className="mt-1 max-h-[180px] space-y-1 overflow-y-auto text-[12px]">
          {list.map((d) => <li key={d.id} className="[overflow-wrap:anywhere]"><b>{d.driverName}</b> · {money(d.amount)}<span className="block text-subtle">{resolved ? d.resolvedNote : d.description}</span></li>)}
        </ul>
      ) : null}
    </div>
  );
}

function SettleCell({ r, onApprove }: { r: Day; onApprove: () => void }) {
  const s = r.settlement;
  if (s?.status === 'COMPLETED') return (
    <div className="text-[12.5px]"><Badge tone="ok">✓ Тооцоо нийлсэн</Badge>
      <div className="mt-0.5 text-muted">Бэлэн {money(s.cashAmount)} · Данс {money(s.bankAmount)}{s.debtAmount ? <> · <b className="text-bad-ink">Өр {money(s.debtAmount)}</b></> : null}</div>
      <div className="text-[11.5px] text-subtle">{s.approvedByName} · {ubDateTime(s.approvedAt)}</div></div>
  );
  if (s?.status === 'PENDING') return (
    <div className="text-[12.5px]"><Badge tone="warn">Хүсэлт явуулсан</Badge>
      <div className="mt-0.5 text-muted">Бэлэн {money(s.cashAmount)} · Данс {money(s.bankAmount)}{s.debtAmount ? ` · Өр ${money(s.debtAmount)}` : ''}</div>
      <Button size="sm" variant="primary" className="mt-1" onClick={onApprove}>Тооцоо нийлэх</Button></div>
  );
  return <span className="text-[12.5px] text-subtle">{r.out + r.notReceived ? `Дуусаагүй ${r.out + r.notReceived}` : 'Жолооч илгээгээгүй'}</span>;
}

function PaymentLine({ p, onDone, onErr }: { p: Payment; onDone: () => void; onErr: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  const set = async (approved: boolean) => { setBusy(true); try { await api(`/api/accounting/payments/${p.id}`, { method: 'POST', json: { approved } }); onDone(); } catch (e) { onErr(msg(e)); } finally { setBusy(false); } };
  return (
    <div className="mt-1.5 rounded-[10px] border border-line bg-surface2/60 px-2 py-1.5 text-[12px]">
      <div className="flex items-center justify-between gap-2"><b>{p.kind === 'ADVANCE' ? 'Урьдчилгаа' : 'Нэмэлт бараа'} {money(p.amount)}</b>
        {p.approved ? <button disabled={busy} onClick={() => void set(false)} className="text-[11.5px] font-semibold text-ok-ink" title="Буцаах">✓ Зөвшөөрсөн</button>
          : <Button size="sm" variant="dark" loading={busy} className="!h-7 !px-2 !text-[12px]" onClick={() => void set(true)}>Зөвшөөрөх</Button>}</div>
      {p.note ? <div className="text-subtle [overflow-wrap:anywhere]">{p.note}</div> : null}
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
  const handoverOk = r.total === r.delivered + r.cancelled + r.excluded + r.postponed + r.out + r.notReceived;
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {([['Нийт', r.total], ['Хүргэсэн', r.delivered], ['Цуцласан', r.cancelled + r.excluded], ['Маргааш', r.postponed], ['Хүргэлтэд', r.out + r.notReceived], ['Гүйцэтгэл', pct(r.perf)], ['Цалин', money(r.salary)], ['Хүлээн авах', money(r.toReceive)]] as const).map(([l, v]) => (
          <div key={l} className="min-w-0 rounded-[12px] border border-line bg-surface px-3 py-2"><div className="text-[11.5px] font-semibold text-subtle">{l}</div><div className="truncate text-[17px] font-extrabold">{v}</div></div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {r.handover ? <Badge tone={handoverOk && !(r.out + r.notReceived) ? 'ok' : 'warn'}>{handoverOk && !(r.out + r.notReceived) ? `✅ ПАДААН ТААРСАН · ${r.handover.number}: ${r.total} захиалга` : `⚠️ ${r.handover.number}: дуусаагүй ${r.out + r.notReceived}`}</Badge> : <Badge>Падаангүй</Badge>}
        {r.partialCount ? <Badge tone="warn">Хэсэгчилсэн хүргэлт {r.partialCount} · болиулсан {money(r.refusedAmount)}</Badge> : null}
        {extraSale.length ? <Badge tone="warn">⚠️ Нэмэлт бараа зарсан {money(r.extraSale.amount)} — тооцоонд орохгүй</Badge> : null}
        {extraTake.length ? <Badge tone="info">Нэмэлт бараа авсан {extraTake.reduce((n, x) => n + x.lines.reduce((m, l) => m + l.qty, 0), 0)}ш</Badge> : null}
        {d.debtTotal ? <Badge tone="bad">Нээлттэй өр {money(d.debtTotal)}</Badge> : null}
        {r.locked ? <Badge tone="ok">🔒 Баталгаажсан</Badge> : null}
      </div>
      <div className="grid gap-2 lg:grid-cols-3">
        <div className="rounded-[14px] border border-line bg-surface p-3">
          <div className="mb-1 text-[13px] font-extrabold">Тооцооны задаргаа</div>
          <Row l={`Хүргэсэн дүн (${r.delivered})`} v={money(r.deliveredAmount)} />
          <Row l={`− Орон нутаг (${r.prepaidCount})`} v={money(r.prepaidAmount)} />
          <Row l={`− Цалин (${r.delivered} × ${money(r.rate)})`} v={money(r.salary)} />
          <Row l="= Хүлээн авах дүн" v={money(r.toReceive)} strong />
          <div className="mt-1 text-[12px] text-subtle">Цуцлагдсан дүн {money(r.cancelledAmount)} (тооцоонд орохгүй)</div>
        </div>
        <div className="rounded-[14px] border border-line bg-surface p-3">
          <div className="mb-1 text-[13px] font-extrabold">Гүйцэтгэлийн тооцоо</div>
          <Row l="Хүргэсэн" v={r.delivered} /><Row l="Цуцласан + Маргааш" v={r.cancelled + r.postponed} />
          {r.excluded ? <Row l="Хасагдсан (тооцоонд ороогүй)" v={r.excluded} /> : null}
          <Row l="Гүйцэтгэл" v={r.perfOverride !== null ? `${pct(r.perfCalc)} → ${pct(r.perfOverride)} (гараар)` : pct(r.perf)} strong />
          <Row l={`Нэг захиалга · ${TIER_L[r.tier]}`} v={money(r.rate)} />
          <details className="mt-1 text-[12px] text-muted"><summary className="cursor-pointer font-semibold">Цалингийн хувь тооцоолох дүрэм</summary>
            {d.rulesText.map((t) => <div key={t.key} className={clsx('mt-1 rounded-lg px-2 py-1', (t.key === r.tier || (t.key === 'big' && r.tier === 'manual')) && 'bg-accent-soft text-accent-ink')}><b>{t.title}</b>: {t.lines.join(' · ')}</div>)}
          </details>
        </div>
        <div className="rounded-[14px] border border-line bg-surface p-3">
          <div className="mb-1 text-[13px] font-extrabold">Төлбөрийн мэдээлэл</div>
          <Row l="Бэлэн" v={money(r.cash)} /><Row l="Данс" v={money(r.bank)} /><Row l="Төлөөгүй (жолооч тушаана)" v={money(r.unpaid)} tone={r.unpaid ? 'warn' : undefined} />
          <Row l="Урьдчилж төлсөн" v={money(r.prepaidAmount)} />
          {r.settlement && r.settlement.status !== 'DRAFT' ? <div className="mt-1.5 border-t border-line pt-1.5 text-[12.5px]"><b>{r.settlement.status === 'COMPLETED' ? 'Тооцоо нийлсэн' : 'Илгээсэн'}:</b> Бэлэн {money(r.settlement.cashAmount)} · Данс {money(r.settlement.bankAmount)} · Өр {money(r.settlement.debtAmount)}</div> : null}
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
  return (
    <Modal open onClose={onClose} size="xl" title={r ? r.driverName : 'Жолооч'} subtitle={r ? `${date} · ${d?.modeLabel} гүйцэтгэл${r.handover ? ` · ${r.handover.number}` : ''}` : date}
      footer={<>{r && !r.locked ? <Button onClick={() => onPerf(r)}>✏️ Гүйцэтгэл засах</Button> : null}{r?.settlement?.status === 'PENDING' ? <Button variant="primary" onClick={() => onApprove(r)}>Тооцоо нийлэх</Button> : null}<Button onClick={onClose}>Хаах</Button></>}>
      {err ? <Notice>{err}</Notice> : null}
      {d && r ? (
        <div className="flex flex-col gap-3">
          <DayPanels d={d} />
          {d.debts.length ? (
            <div className="rounded-[14px] border border-line bg-surface p-3 text-[12.5px]">
              <div className="mb-1 text-[13px] font-extrabold">Нээлттэй өр (компанид)</div>
              {d.debts.map((x) => <div key={x.id} className="flex justify-between gap-2 py-0.5"><span className="min-w-0 [overflow-wrap:anywhere]">{x.description}</span><b className="shrink-0 text-bad-ink">{money(x.amount)}</b></div>)}
            </div>
          ) : null}
          <div className="overflow-hidden rounded-[14px] border border-line">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-[12.5px]">
                <thead className="bg-surface2 text-[11.5px] text-muted"><tr><th className="px-2.5 py-2 text-left">№</th><th className="px-2.5 py-2 text-left">Утас · хаяг</th><th className="px-2.5 py-2 text-left">Бараа</th><th className="px-2.5 py-2 text-right">Дүн</th><th className="px-2.5 py-2 text-left">Төлөв</th><th className="px-2.5 py-2 text-left">Төлбөр</th><th className="px-2.5 py-2" /></tr></thead>
                <tbody className="divide-y divide-line">
                  {d.orders.map((o) => {
                    const b = orderBadge(o);
                    const canToggle = !r.locked && !o.postponed && ['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'].includes(o.status);
                    return (
                      <tr key={o.id} className="align-top">
                        <td className="px-2.5 py-2 font-bold"><Link href={`/orders?q=${o.number}`} className="underline decoration-dotted">{o.number}</Link></td>
                        <td className="max-w-[240px] px-2.5 py-2"><span className="font-semibold">{o.phone}</span><span className="block text-subtle [overflow-wrap:anywhere]">{[o.province, o.district, o.addressDetail].filter(Boolean).join(', ')}</span></td>
                        <td className="max-w-[260px] px-2.5 py-2 [overflow-wrap:anywhere]">{o.lines.map((l, i) => <span key={i} className="block">{l.name}{l.label ? ` · ${l.label}` : ''} ×{l.qty}{l.refusedQty ? <b className="text-warn"> (болиулсан {l.refusedQty})</b> : null}</span>)}</td>
                        <td className="px-2.5 py-2 text-right whitespace-nowrap font-bold">{money(o.total)}{o.originalTotal !== null && o.originalTotal !== o.total ? <span className="block text-[11px] font-normal text-subtle line-through">{money(o.originalTotal)}</span> : null}</td>
                        <td className="max-w-[200px] px-2.5 py-2"><Badge tone={b.tone}>{b.l}</Badge>{o.cancelNote ? <span className="mt-0.5 block text-[11.5px] text-subtle [overflow-wrap:anywhere]">{o.cancelNote}</span> : null}<span className="block text-[11px] text-subtle">{o.deliveredByName ?? o.cancelledByName ?? ''}</span></td>
                        <td className="px-2.5 py-2">{o.prepaid ? <Badge tone="accent">Орон нутаг</Badge> : o.deliveryPayment ? PAY_L[o.deliveryPayment] : '—'}</td>
                        <td className="px-2.5 py-2 text-right">{canToggle ? <Button size="sm" onClick={() => setToggle(o)}>Төлөв солих</Button> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!d.orders.length ? <p className="px-4 py-6 text-center text-muted">Падаанд захиалга алга</p> : null}
          </div>
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
