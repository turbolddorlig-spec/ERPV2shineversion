'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Badge } from '@/components/ui/Badge';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';

/**
 * Ажилтны цалин (Модуль 7б, хуучин ERP-ийн логикоор): сар → ажилтан бүр 1–15 ба 16–сүүл, шилжүүлэх дүн, төлөв;
 * цалин бодох цонх (үндсэн/захиалга, урамшуулал, нэмэлт, суутгал, торгууль, зээлсэн бараа, өр), цоож, шилжүүлсэн;
 * ажлын хуваарь, ажилтны өр, гадны ажилтан, жолоочийн торгууль.
 */
const EVAL_LABEL = 'Үнэлгээний цалин (автомат)';
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const thisYm = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
const shiftYm = (ym: string, n: number) => { const [y, m] = ym.split('-').map(Number) as [number, number]; const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const MONTHS = ['1-р сар', '2-р сар', '3-р сар', '4-р сар', '5-р сар', '6-р сар', '7-р сар', '8-р сар', '9-р сар', '10-р сар', '11-р сар', '12-р сар'];
const ymLabel = (ym: string) => `${ym.slice(0, 4)} оны ${MONTHS[Number(ym.slice(5)) - 1]}`;

interface PeriodCell { id: number; transferSalary: number; transferred: boolean; isLocked: boolean; orderCount: number; totalDeductions: number; penaltyDeducted: number }
interface BoardRow { key: string; name: string; phone?: string; role: string; roleLabel: string; external: boolean; configured: boolean; salaryType: string; baseSalary: number; periods: (PeriodCell | null)[] }
interface Board { ym: string; periods: { start: string; end: string; label: string; half: 1 | 2 }[]; rows: BoardRow[]; totals: { p1: number; p2: number; all: number; transferred: number }; driverPenalties: { userId: string; name: string; count: number; amount: number; deducted: number }[]; hasLockCode: boolean; isSuperAdmin: boolean }
const GROUPS: [string, string, (r: BoardRow) => boolean][] = [
  ['all', 'Бүгд', () => true], ['opp', 'Оператор', (r) => r.role.startsWith('OPERATOR')], ['mk', 'Маркетинг', (r) => r.role.startsWith('MARKETING')],
  ['wh', 'Агуулах', (r) => r.role === 'WAREHOUSE'], ['other', 'Бусад', (r) => !r.external && !r.role.startsWith('OPERATOR') && !r.role.startsWith('MARKETING') && r.role !== 'WAREHOUSE'], ['ext', 'Гадны', (r) => r.external],
];

export function SalaryClient() {
  const [ym, setYm] = useState(thisYm());
  const [tab, setTab] = useState<'salary' | 'schedule' | 'debts' | 'drivers'>('salary');
  const [group, setGroup] = useState('all');
  const [q, setQ] = useState('');
  const [d, setD] = useState<Board | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ row: BoardRow; half: 1 | 2 } | null>(null);
  const [cfg, setCfg] = useState<BoardRow | null>(null);
  const [ext, setExt] = useState(false);
  const [unlock, setUnlock] = useState<{ id: number; name: string } | null>(null);
  const [codeDlg, setCodeDlg] = useState(false);
  const load = useCallback(async () => { try { setD(await api(`/api/salary?ym=${ym}`)); setErr(null); } catch (e) { setErr(msg(e)); } }, [ym]);
  useEffect(() => { void load(); }, [load]);
  const post = async (json: Record<string, unknown>, m?: string) => { try { await api('/api/salary', { method: 'POST', json }); if (m) setOk(m); await load(); } catch (e) { setErr(msg(e)); } };
  const rows = useMemo(() => {
    const g = GROUPS.find((x) => x[0] === group)![2];
    return (d?.rows ?? []).filter((r) => g(r) && (!q || r.name.toLowerCase().includes(q.toLowerCase())));
  }, [d, group, q]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-[24px] font-extrabold tracking-tight">Ажилтны цалин</h1><p className="text-[13.5px] text-muted">Сард 2 удаа: 1–15, 16–сарын сүүл · жолоочийн цалин «Тооцоо»-д</p></div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setExt(true)}>+ Гадны ажилтан</Button>
          {d?.isSuperAdmin ? <Button size="sm" onClick={() => setCodeDlg(true)}>{d.hasLockCode ? 'Цоожны код солих' : 'Цоожны код тохируулах'}</Button> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-full border border-line bg-surface p-1">
          <button onClick={() => setYm(shiftYm(ym, -1))} className="h-8 w-8 rounded-full text-[17px] font-bold hover:bg-surface2" aria-label="Өмнөх сар">‹</button>
          <span className="px-2 text-[14px] font-bold">{ymLabel(ym)}</span>
          <button onClick={() => setYm(shiftYm(ym, 1))} className="h-8 w-8 rounded-full text-[17px] font-bold hover:bg-surface2" aria-label="Дараах сар">›</button>
        </div>
        <div className="flex gap-1 overflow-x-auto rounded-[14px] bg-surface2 p-1" role="tablist">
          {([['salary', 'Цалин'], ['schedule', 'Ажлын хуваарь'], ['debts', 'Ажилтны өр'], ['drivers', 'Жолоочийн торгууль']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={clsx('h-9 shrink-0 rounded-[11px] px-3 text-[13px] font-bold', tab === k ? 'bg-surface text-ink shadow-card' : 'text-muted')}>{l}</button>
          ))}
        </div>
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}

      {tab === 'salary' && d ? (
        <>
          <section className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {([['Нийт шилжүүлэх', d.totals.all, true], ['1–15', d.totals.p1, false], [d.periods[1]!.label.split(' ')[1]!, d.totals.p2, false], ['Шилжүүлсэн', d.totals.transferred, false]] as const).map(([l, v, big]) => (
              <div key={l} className={clsx('min-w-0 rounded-[16px] px-4 py-3', big ? 'bg-ink text-on-ink' : 'border border-line bg-surface')}><div className={clsx('text-[12.5px] font-semibold', big ? 'opacity-75' : 'text-muted')}>{l}</div><div className="truncate text-[22px] font-extrabold">{money(v)}</div></div>
            ))}
          </section>
          <section className="overflow-hidden rounded-[20px] border border-line bg-surface shadow-card">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
              <div className="flex max-w-full gap-1 overflow-x-auto">{GROUPS.map(([k, l]) => <button key={k} onClick={() => setGroup(k)} className={clsx('h-8 shrink-0 rounded-full px-3 text-[13px] font-bold', group === k ? 'bg-ink text-on-ink' : 'text-muted hover:bg-surface2')}>{l}</button>)}</div>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ажилтан хайх" className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-3 text-[13.5px] sm:ml-auto sm:w-[180px] sm:flex-none" aria-label="Ажилтан хайх" />
            </div>
            <ul className="divide-y divide-line">
              {rows.map((r) => (
                <li key={r.key} className="grid gap-x-4 gap-y-2 px-4 py-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
                  <div className="min-w-0">
                    <b className="block text-[14.5px] [overflow-wrap:anywhere]">{r.name}</b>
                    <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-subtle">
                      <span className="[overflow-wrap:anywhere]">{r.roleLabel}</span>
                      {r.configured ? <span>· {r.salaryType === 'ORDER_BASED' ? 'Захиалгаар' : `Тогтмол ${money(r.baseSalary)}`}</span> : <Badge tone="warn">Тохиргоогүй</Badge>}
                      <button onClick={() => setCfg(r)} className="font-semibold text-accent-ink">Тохируулах</button>
                      {r.external ? <button onClick={() => { if (window.confirm(`${r.name}-г хасах уу?`)) void post({ action: 'external-remove', id: Number(r.key.slice(2)) }); }} className="font-semibold text-bad-ink">Хасах</button> : null}
                    </div>
                  </div>
                  {[1, 2].map((h) => {
                    const c = r.periods[h - 1];
                    return (
                      <button key={h} onClick={() => setEdit({ row: r, half: h as 1 | 2 })} className={clsx('flex min-w-0 items-center justify-between gap-2 rounded-[12px] border px-3 py-2 text-left hover:bg-surface2', c ? 'border-line' : 'border-dashed border-line')}>
                        <span className="min-w-0">
                          <span className="block text-[11.5px] font-semibold text-subtle">{h === 1 ? '1–15' : `16–сүүл`}</span>
                          {c ? <b className="block text-[16px]">{money(c.transferSalary)}</b> : <span className="text-[13px] text-muted">Бодох →</span>}
                          {c?.orderCount ? <span className="block text-[11.5px] text-subtle">{c.orderCount} захиалга</span> : null}
                        </span>
                        {c ? <span className="flex shrink-0 flex-col items-end gap-1">{c.isLocked ? <Badge>🔒</Badge> : null}{c.transferred ? <Badge tone="ok">Шилжүүлсэн</Badge> : <Badge tone="warn">Хүлээгдэж буй</Badge>}</span> : null}
                      </button>
                    );
                  })}
                </li>
              ))}
              {!rows.length ? <li className="px-4 py-12 text-center text-muted">Ажилтан алга</li> : null}
            </ul>
          </section>
        </>
      ) : null}
      {tab === 'schedule' && d ? <ScheduleTab ym={ym} rows={d.rows} onErr={setErr} /> : null}
      {tab === 'debts' && d ? <DebtsTab rows={d.rows} onErr={setErr} /> : null}
      {tab === 'drivers' && d ? (
        <section className="overflow-hidden rounded-[20px] border border-line bg-surface shadow-card">
          <div className="border-b border-line px-4 py-2.5 text-[14px] font-extrabold">Жолоочийн торгууль · {ymLabel(ym)} <span className="font-normal text-muted">(жолоочийн цалин «Тооцоо»-д)</span></div>
          <ul className="divide-y divide-line">
            {d.driverPenalties.map((x) => <li key={x.userId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13.5px]"><span className="min-w-0 [overflow-wrap:anywhere]"><b>{x.name}</b> · {x.count} удаа</span><span className="shrink-0 text-right"><b className="text-bad-ink">{money(x.amount)}</b><span className="block text-[11.5px] text-subtle">хассан {money(x.deducted)}</span></span></li>)}
            {!d.driverPenalties.length ? <li className="px-4 py-10 text-center text-muted">Жолоочийн торгууль алга</li> : null}
          </ul>
        </section>
      ) : null}

      {edit && d ? <RecordDialog ym={ym} row={edit.row} half={edit.half} hasLockCode={d.hasLockCode} isSA={d.isSuperAdmin} onClose={() => setEdit(null)} onDone={async (m) => { if (m) setOk(m); await load(); }} onUnlock={(id) => setUnlock({ id, name: edit.row.name })} /> : null}
      {cfg ? <ConfigDialog row={cfg} onClose={() => setCfg(null)} onDone={async () => { setCfg(null); setOk('Цалингийн тохиргоо хадгалагдлаа'); await load(); }} /> : null}
      {ext ? <ExternalDialog onClose={() => setExt(false)} onDone={async () => { setExt(false); await load(); }} /> : null}
      {unlock && d ? <UnlockDialog id={unlock.id} name={unlock.name} needCode={d.hasLockCode} onClose={() => setUnlock(null)} onDone={async () => { setUnlock(null); setEdit(null); setOk('Цалингийн цоож тайлагдлаа — торгууль, өрийн суутгал буцлаа'); await load(); }} /> : null}
      {codeDlg ? <LockCodeDialog onClose={() => setCodeDlg(false)} onDone={async () => { setCodeDlg(false); setOk('Цоожны код хадгалагдлаа'); await load(); }} /> : null}
    </div>
  );
}

// ───────────────────────── Цалин бодох ─────────────────────────

interface Prep {
  staff: { key: string; name: string; roleLabel: string; external: boolean };
  period: { start: string; end: string; label: string };
  auto: { cfg: { salaryType: string; baseSalary: number; bonusSalary: number; oppRatePerOrder: number; dailyRate: number; bankName: string; bankAccount: string }; isOpp: boolean; totalDays: number; workingDays: number; offDays: Record<string, number>; dailyRate: number; calcBase: number; orderCount: number; orderSalary: number;
    penalties: { id: number; category: string; createdAt: string; amount: number; remaining: number }[]; penaltyTotal: number;
    loans: { id: number; issuedAt: string; pieces: number; amount: number; note: string | null }[]; debts: { id: number; description: string; totalAmount: number; remainingAmount: number }[]; evalSalary?: number };
  record: null | { id: number; version: number; baseSalary: number; bonusSalary: number; additions: { label: string; amount: number }[]; deductions: { label: string; amount: number }[]; penaltyDeducted: number; penaltyTotal: number;
    loans: { loanId: number; label: string; amount: number }[]; debtPayments: { debtId: number; label: string; amount: number }[]; notes: string | null; bankName: string; bankAccount: string; transferSalary: number; transferred: boolean; isLocked: boolean; lockedByName: string | null; lockedAt: string | null; orderCount: number; orderSalary: number };
  dayLabels: Record<string, string>;
}
const digits = (s: string) => s.replace(/\D/g, '');

function Lines({ title, items, set, disabled, placeholder }: { title: string; items: { label: string; amount: string }[]; set: (x: { label: string; amount: string }[]) => void; disabled: boolean; placeholder: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between"><span className="text-[13px] font-bold">{title}</span>{!disabled ? <button onClick={() => set([...items, { label: '', amount: '' }])} className="text-[12.5px] font-semibold text-accent-ink">+ Нэмэх</button> : null}</div>
      {items.map((x, i) => (
        <div key={i} className="mb-1.5 grid grid-cols-[1fr_110px_auto] gap-1.5">
          <input value={x.label} disabled={disabled} onChange={(e) => set(items.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} placeholder={placeholder} className="h-10 min-w-0 rounded-[10px] border border-line bg-surface px-2.5 text-[13.5px]" aria-label={`${title} нэр`} />
          <input value={x.amount} disabled={disabled} inputMode="numeric" onChange={(e) => set(items.map((y, j) => (j === i ? { ...y, amount: digits(e.target.value) } : y)))} placeholder="Дүн" className="h-10 min-w-0 rounded-[10px] border border-line bg-surface px-2.5 text-right text-[13.5px]" aria-label={`${title} дүн`} />
          {!disabled ? <button onClick={() => set(items.filter((_, j) => j !== i))} className="px-1 text-[16px] text-subtle" aria-label="Хасах">×</button> : <span />}
        </div>
      ))}
      {!items.length ? <p className="text-[12.5px] text-subtle">—</p> : null}
    </div>
  );
}

function RecordDialog({ ym, row, half, isSA, hasLockCode, onClose, onDone, onUnlock }: { ym: string; row: BoardRow; half: 1 | 2; isSA: boolean; hasLockCode: boolean; onClose: () => void; onDone: (m?: string) => void; onUnlock: (id: number) => void }) {
  const [p, setP] = useState<Prep | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [f, setF] = useState({ base: '', bonus: '', penalty: '', notes: '', bankName: '', bankAccount: '' });
  const [adds, setAdds] = useState<{ label: string; amount: string }[]>([]);
  const [deds, setDeds] = useState<{ label: string; amount: string }[]>([]);
  const [loanIds, setLoanIds] = useState<number[]>([]);
  const [debtPay, setDebtPay] = useState<Record<number, string>>({});
  const [hist, setHist] = useState<{ action: string; actorName: string; at: string; details: Record<string, unknown> | null }[] | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<Prep>(`/api/salary?prepare=${row.key}&ym=${ym}&half=${half}`);
      setP(r); setErr(null);
      const rec = r.record; const a = r.auto;
      const s = (n: number) => String(n);
      setF({ base: s(rec ? rec.baseSalary : a.calcBase), bonus: s(rec ? rec.bonusSalary : a.cfg.bonusSalary), penalty: s(rec ? rec.penaltyDeducted : a.penaltyTotal), notes: rec?.notes ?? '', bankName: rec?.bankName ?? a.cfg.bankName, bankAccount: rec?.bankAccount ?? a.cfg.bankAccount });
      setAdds((rec?.additions ?? []).filter((x) => x.label !== EVAL_LABEL).map((x) => ({ label: x.label, amount: s(x.amount) })));
      setDeds((rec?.deductions ?? []).map((x) => ({ label: x.label, amount: s(x.amount) })));
      setLoanIds(rec ? rec.loans.map((l) => l.loanId) : a.loans.map((l) => l.id));
      setDebtPay(Object.fromEntries((rec?.debtPayments ?? []).map((x) => [x.debtId, s(x.amount)])));
    } catch (e) { setErr(msg(e)); }
  }, [row.key, ym, half]);
  useEffect(() => { void load(); }, [load]);
  const locked = !!p?.record?.isLocked;
  const a = p?.auto;
  const orderBased = !!a && !p!.staff.external && a.cfg.salaryType === 'ORDER_BASED' && a.isOpp;
  const num = (s: string) => Number(s) || 0;
  const sumL = (x: { amount: string }[]) => x.reduce((s, y) => s + num(y.amount), 0);
  const loanSel = locked ? (p?.record?.loans ?? []).map((l) => ({ id: l.loanId, amount: l.amount })) : (a?.loans ?? []).filter((l) => loanIds.includes(l.id));
  const loanTotal = loanSel.reduce((s, l) => s + l.amount, 0);
  const debtTotal = Object.values(debtPay).reduce((s, v) => s + num(v), 0);
  const evalSal = a?.evalSalary ?? 0;
  const gross = (orderBased ? (a?.orderSalary ?? 0) : num(f.base)) + num(f.bonus) + sumL(adds) + evalSal;
  const transfer = gross - sumL(deds) - num(f.penalty) - debtTotal - loanTotal;
  const save = async () => {
    setBusy('save'); setErr(null);
    try {
      await api('/api/salary', { method: 'POST', json: { action: 'save', staffKey: row.key, ym, half, version: p?.record?.version, baseSalary: orderBased ? undefined : num(f.base), bonusSalary: num(f.bonus), penaltyDeducted: num(f.penalty),
        additions: adds.map((x) => ({ label: x.label, amount: num(x.amount) })), deductions: deds.map((x) => ({ label: x.label, amount: num(x.amount) })),
        loanIds, debtPayments: Object.entries(debtPay).map(([k, v]) => ({ debtId: Number(k), amount: num(v) })), notes: f.notes, bankName: f.bankName, bankAccount: f.bankAccount } });
      await load(); onDone(`${row.name}: цалин хадгалагдлаа`);
    } catch (e) { setErr(msg(e)); } finally { setBusy(null); }
  };
  const act = async (action: string, extra: Record<string, unknown> = {}, m?: string) => {
    setBusy(action); setErr(null);
    try { await api('/api/salary', { method: 'POST', json: { action, id: p?.record?.id, ...extra } }); await load(); onDone(m); } catch (e) { setErr(msg(e)); } finally { setBusy(null); }
  };
  const showHist = async () => { try { setHist((await api<{ items: NonNullable<typeof hist> }>(`/api/salary?history=${p?.record?.id}`)).items); } catch (e) { setErr(msg(e)); } };
  return (
    <Modal open onClose={onClose} size="xl" title={`${row.name} · ${p?.period.label ?? ''}`} subtitle={`${row.roleLabel}${locked ? ` · 🔒 ${p?.record?.lockedByName} ${ubDateTime(p?.record?.lockedAt)}` : ''}`}
      footer={<>
        {p?.record ? <Button size="sm" variant="ghost" className="mr-auto" onClick={() => void showHist()}>Түүх</Button> : null}
        {p?.record && !locked ? <Button loading={busy === 'lock'} onClick={() => { if (window.confirm('Цоожлох уу? Торгууль «Цалингаас хассан», зээл «суутгасан», өрийн төлөлт бүртгэгдэнэ.')) void act('lock', {}, `${row.name}: цалин цоожлогдлоо`); }}>🔒 Цоожлох</Button> : null}
        {locked ? <Button onClick={() => (hasLockCode || isSA ? onUnlock(p!.record!.id) : setErr('Цоожны код тохируулаагүй — Супер админ тайлна'))}>Цоож тайлах</Button> : null}
        {p?.record ? <Button loading={busy === 'transferred'} onClick={() => void act('transferred', { value: !p.record!.transferred }, p.record!.transferred ? 'Шилжүүлээгүй болголоо' : 'Шилжүүлсэн гэж тэмдэглэлээ')}>{p.record.transferred ? 'Шилжүүлээгүй болгох' : '✓ Шилжүүлсэн'}</Button> : null}
        {!locked ? <Button variant="primary" loading={busy === 'save'} disabled={!p} onClick={() => void save()}>Хадгалах</Button> : null}
      </>}>
      {err ? <Notice>{err}</Notice> : null}
      {p && a ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
          <div className="flex min-w-0 flex-col gap-4">
            <section className="rounded-[14px] border border-line p-3">
              <div className="mb-2 text-[13px] font-bold">{orderBased ? 'Захиалгын цалин' : 'Үндсэн цалин'}</div>
              {orderBased ? (
                <div className="text-[14px]"><b>{a.orderCount}</b> хүргэгдсэн захиалга × {money(a.cfg.oppRatePerOrder)} = <b>{money(a.orderSalary)}</b><p className="text-[12px] text-subtle">Тухайн хугацаанд авсан, хүргэгдсэн (мөнгө орсон) захиалга</p></div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
                  <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Үндсэн цалин (₮)<input value={f.base} disabled={locked} inputMode="numeric" onChange={(e) => setF({ ...f, base: digits(e.target.value) })} className="h-11 rounded-xl border border-line bg-surface px-3 text-[16px] font-bold text-ink" /></label>
                  <div className="text-[12.5px] text-muted sm:pt-5">{a.workingDays}/{a.totalDays} ажилласан өдөр × {money(a.dailyRate)} = <b className="text-ink">{money(a.calcBase)}</b>
                    {Object.keys(a.offDays).length ? <span className="block">{Object.entries(a.offDays).map(([k, n]) => `${p.dayLabels[k]} ${n}`).join(' · ')}</span> : null}
                    {!locked && num(f.base) !== a.calcBase ? <button onClick={() => setF({ ...f, base: String(a.calcBase) })} className="block font-semibold text-accent-ink">Тооцоолсныг ашиглах</button> : null}</div>
                </div>
              )}
              <label className="mt-2 flex max-w-[260px] flex-col gap-1 text-[12.5px] font-semibold text-muted">Урамшууллын цалин (₮)<input value={f.bonus} disabled={locked} inputMode="numeric" onChange={(e) => setF({ ...f, bonus: digits(e.target.value) })} className="h-11 rounded-xl border border-line bg-surface px-3 text-ink" /></label>
            </section>
            <section className="grid gap-3 rounded-[14px] border border-line p-3 sm:grid-cols-2">
              <Lines title="Нэмэлт орлого" items={adds} set={setAdds} disabled={locked} placeholder="Жишээ: илүү цаг" />
              {evalSal > 0 ? <p className="text-[12.5px] text-muted">+ {EVAL_LABEL}: <b className="text-ink">{money(evalSal)}</b> — «Барааны гарц → Үнэлгээ»-ээс автоматаар</p> : null}
              <Lines title="Хоцролт / Суутгал" items={deds} set={setDeds} disabled={locked} placeholder="Жишээ: хоцролт 3 удаа" />
            </section>
            {!p.staff.external ? (
              <section className="rounded-[14px] border border-line p-3">
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2"><span className="text-[13px] font-bold">Торгууль</span><span className="text-[12.5px] text-muted">хасагдаагүй нийт <b className="text-bad-ink">{money(locked ? p.record!.penaltyTotal : a.penaltyTotal)}</b></span></div>
                {!locked && a.penalties.length ? <ul className="mb-2 max-h-[140px] overflow-y-auto text-[12.5px]">{a.penalties.map((x) => <li key={x.id} className="flex justify-between gap-2 py-0.5"><span className="min-w-0 [overflow-wrap:anywhere]">{x.category} · {ubDateTime(x.createdAt).slice(0, 10)}</span><b className="shrink-0">{money(x.remaining)}</b></li>)}</ul> : null}
                <label className="flex max-w-[260px] flex-col gap-1 text-[12.5px] font-semibold text-muted">Цалингаас хасах дүн (₮)<input value={f.penalty} disabled={locked} inputMode="numeric" onChange={(e) => setF({ ...f, penalty: digits(e.target.value) })} className="h-11 rounded-xl border border-line bg-surface px-3 text-ink" /></label>
                {num(f.penalty) < (locked ? p.record!.penaltyTotal : a.penaltyTotal) ? <p className="mt-1 text-[12px] text-warn">Хасаагүй үлдэгдэл {money((locked ? p.record!.penaltyTotal : a.penaltyTotal) - num(f.penalty))} — дараагийн цалинд</p> : null}
              </section>
            ) : null}
            {(locked ? p.record!.loans.length : a.loans.length) ? (
              <section className="rounded-[14px] border border-line p-3">
                <div className="mb-1 text-[13px] font-bold">Зээлсэн бараа (ажилчдын хөнгөлөлттэй үнээр)</div>
                {locked ? p.record!.loans.map((l) => <div key={l.loanId} className="flex justify-between py-0.5 text-[13px]"><span>{l.label}</span><b>{money(l.amount)}</b></div>)
                  : a.loans.map((l) => <label key={l.id} className="flex items-center justify-between gap-2 py-1 text-[13px]"><span className="flex min-w-0 items-center gap-2"><input type="checkbox" className="h-4 w-4" checked={loanIds.includes(l.id)} onChange={(e) => setLoanIds(e.target.checked ? [...loanIds, l.id] : loanIds.filter((x) => x !== l.id))} /><span className="[overflow-wrap:anywhere]">Зээл #{l.id} · {l.pieces}ш · {ubDateTime(l.issuedAt).slice(0, 10)}{l.note ? ` · ${l.note}` : ''}</span></span><b className="shrink-0">{money(l.amount)}</b></label>)}
                <p className="text-[12px] text-subtle">Цоожлоход «Бараа зээл»-д «Цалингаас суутгасан» болно.</p>
              </section>
            ) : null}
            {a.debts.length || Object.keys(debtPay).length ? (
              <section className="rounded-[14px] border border-line p-3">
                <div className="mb-1 text-[13px] font-bold">Өрийн суутгал</div>
                {(locked ? p.record!.debtPayments.map((x) => ({ id: x.debtId, description: x.label, remainingAmount: 0 })) : a.debts).map((dd) => (
                  <div key={dd.id} className="grid grid-cols-[1fr_120px] items-center gap-2 py-1 text-[13px]">
                    <span className="min-w-0 [overflow-wrap:anywhere]">{dd.description}{!locked ? <span className="text-subtle"> · үлд. {money(dd.remainingAmount)}</span> : null}</span>
                    <input value={debtPay[dd.id] ?? ''} disabled={locked} inputMode="numeric" onChange={(e) => setDebtPay({ ...debtPay, [dd.id]: digits(e.target.value) })} placeholder="0" className="h-10 rounded-[10px] border border-line bg-surface px-2.5 text-right" aria-label={`${dd.description} төлөлт`} />
                  </div>
                ))}
              </section>
            ) : null}
            <section className="grid gap-2 rounded-[14px] border border-line p-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Банк<input value={f.bankName} disabled={locked} onChange={(e) => setF({ ...f, bankName: e.target.value })} className="h-10 rounded-[10px] border border-line bg-surface px-3 text-ink" /></label>
              <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Дансны дугаар<input value={f.bankAccount} disabled={locked} onChange={(e) => setF({ ...f, bankAccount: e.target.value })} className="h-10 rounded-[10px] border border-line bg-surface px-3 text-ink" /></label>
              <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted sm:col-span-2">Тэмдэглэл<textarea value={f.notes} disabled={locked} rows={2} maxLength={1000} onChange={(e) => setF({ ...f, notes: e.target.value })} className="rounded-[10px] border border-line bg-surface px-3 py-2 text-ink" /></label>
            </section>
          </div>
          <aside className="flex h-fit flex-col gap-1 rounded-[16px] bg-surface2 p-4 lg:sticky lg:top-0">
            {([[orderBased ? 'Захиалгын цалин' : 'Үндсэн цалин', orderBased ? a.orderSalary : num(f.base), ''], ['Урамшуулал', num(f.bonus), '+'], ['Нэмэлт орлого', sumL(adds) + evalSal, '+'], ['Суутгал', sumL(deds), '−'], ['Торгууль', num(f.penalty), '−'], ['Өрийн суутгал', debtTotal, '−'], ['Зээлсэн бараа', loanTotal, '−']] as const).map(([l, v, s]) => (
              <div key={l} className="flex justify-between gap-2 text-[13.5px]"><span className="text-muted">{s} {l}</span><b className={clsx(s === '−' && v ? 'text-bad-ink' : '')}>{money(v)}</b></div>
            ))}
            <div className="mt-2 border-t border-line pt-2"><div className="text-[12.5px] font-semibold text-muted">Шилжүүлэх цалин</div><div className={clsx('text-[26px] font-extrabold', transfer < 0 && 'text-bad-ink')}>{money(transfer)}</div></div>
            {p.record ? <div className="text-[12px] text-subtle">{p.record.transferred ? '✓ Шилжүүлсэн' : 'Шилжүүлээгүй'}{locked ? ' · 🔒 цоожтой' : ''}</div> : <div className="text-[12px] text-subtle">Хадгалаагүй</div>}
          </aside>
        </div>
      ) : null}
      {hist ? (
        <Modal open onClose={() => setHist(null)} title="Засварын түүх" footer={<Button onClick={() => setHist(null)}>Хаах</Button>}>
          <ul className="divide-y divide-line text-[13px]">{hist.map((h, i) => <li key={i} className="py-2"><b>{h.actorName}</b> · {ubDateTime(h.at)} · {h.action.replace('salary.', '')}<span className="block text-[12px] text-subtle [overflow-wrap:anywhere]">{h.details ? JSON.stringify((h.details as { changes?: unknown }).changes ?? h.details).slice(0, 300) : ''}</span></li>)}</ul>
        </Modal>
      ) : null}
    </Modal>
  );
}

function ConfigDialog({ row, onClose, onDone }: { row: BoardRow; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<{ config: Record<string, string | number> }>(`/api/salary?config=${row.key}`).then((r) => setF(Object.fromEntries(Object.entries(r.config).map(([k, v]) => [k, String(v ?? '')])))).catch((e) => setErr(msg(e))); }, [row.key]);
  const save = async () => { try { await api('/api/salary', { method: 'POST', json: { action: 'config', staffKey: row.key, ...f } }); onDone(); } catch (e) { setErr(msg(e)); } };
  const isOpp = row.role.startsWith('OPERATOR');
  return (
    <Modal open onClose={onClose} title={`Цалингийн тохиргоо · ${row.name}`} footer={<><Button onClick={onClose}>Болих</Button><Button variant="primary" onClick={() => void save()}>Хадгалах</Button></>}>
      {f ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {!row.external ? <div className="sm:col-span-2"><div className="mb-1 text-[13px] font-semibold text-muted">Цалин бодох төрөл</div><div className="flex gap-2">{([['FIXED', 'Тогтмол цалин'], ['ORDER_BASED', 'Захиалгаар (хүргэгдсэн)']] as const).map(([k, l]) => <button key={k} disabled={k === 'ORDER_BASED' && !isOpp} onClick={() => setF({ ...f, salaryType: k })} className={clsx('h-10 rounded-full border px-3 text-[13px] font-bold disabled:opacity-40', f.salaryType === k ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>{l}</button>)}</div></div> : null}
          {([['baseSalary', 'Үндсэн цалин (сарын, ₮)'], ...(row.external ? [] : [['bonusSalary', 'Урамшууллын цалин (₮)'], ['dailyRate', '1 өдрийн цалин (₮) — 0 бол сарын цалин / хоногоор'], ...(f.salaryType === 'ORDER_BASED' ? [['oppRatePerOrder', '1 захиалга = (₮)']] : [])])] as [string, string][]).map(([k, l]) => (
            <label key={k} className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">{l}<input inputMode="numeric" value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: digits(e.target.value) })} className="h-11 rounded-xl border border-line bg-surface px-3 text-ink" /></label>
          ))}
          <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Банкны нэр<input value={f.bankName ?? ''} onChange={(e) => setF({ ...f, bankName: e.target.value })} placeholder="Хаан банк, Голомт банк..." className="h-11 rounded-xl border border-line bg-surface px-3 text-ink" /></label>
          <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Дансны дугаар<input value={f.bankAccount ?? ''} onChange={(e) => setF({ ...f, bankAccount: e.target.value })} className="h-11 rounded-xl border border-line bg-surface px-3 text-ink" /></label>
        </div>
      ) : null}
      {err ? <div className="mt-2"><Notice>{err}</Notice></div> : null}
    </Modal>
  );
}

function ExternalDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', jobTitle: '', baseSalary: '' });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => { try { await api('/api/salary', { method: 'POST', json: { action: 'external', ...f, baseSalary: Number(f.baseSalary) || 0 } }); onDone(); } catch (e) { setErr(msg(e)); } };
  return (
    <Modal open onClose={onClose} title="Гадны ажилтан нэмэх" subtitle="Системд нэвтэрдэггүй ажилтан (цэвэрлэгч, харуул г.м.)" footer={<><Button onClick={onClose}>Болих</Button><Button variant="primary" onClick={() => void save()}>Нэмэх</Button></>}>
      <div className="grid gap-2">
        <input data-autofocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Нэр" aria-label="Нэр" className="h-11 rounded-xl border border-line bg-surface px-3" />
        <input value={f.jobTitle} onChange={(e) => setF({ ...f, jobTitle: e.target.value })} placeholder="Албан тушаал" aria-label="Албан тушаал" className="h-11 rounded-xl border border-line bg-surface px-3" />
        <input value={f.baseSalary} inputMode="numeric" onChange={(e) => setF({ ...f, baseSalary: digits(e.target.value) })} placeholder="Үндсэн цалин (сарын, ₮)" aria-label="Үндсэн цалин" className="h-11 rounded-xl border border-line bg-surface px-3" />
        {err ? <Notice>{err}</Notice> : null}
      </div>
    </Modal>
  );
}

function UnlockDialog({ id, name, needCode, onClose, onDone }: { id: number; name: string; needCode: boolean; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { try { await api('/api/salary', { method: 'POST', json: { action: 'unlock', id, code } }); onDone(); } catch (e) { setErr(msg(e)); } };
  return (
    <Modal open onClose={onClose} title="Цоож тайлах" subtitle={name} footer={<><Button onClick={onClose}>Болих</Button><Button variant="primary" onClick={() => void go()}>Тайлах</Button></>}>
      {needCode ? <input data-autofocus type="password" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Цоожны код" aria-label="Цоожны код" className="h-11 w-full rounded-xl border border-line bg-surface px-3" /> : <p className="text-[13.5px] text-muted">Код тохируулаагүй — Супер админ шууд тайлна.</p>}
      <p className="mt-2 text-[12.5px] text-subtle">Тайлахад энэ цалингаар хассан торгууль, өрийн төлөлт буцна. Зээл (барааны хөдөлгөөн) хэвээр.</p>
      {err ? <div className="mt-2"><Notice>{err}</Notice></div> : null}
    </Modal>
  );
}

function LockCodeDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { try { await api('/api/salary', { method: 'POST', json: { action: 'lock-code', code } }); onDone(); } catch (e) { setErr(msg(e)); } };
  return (
    <Modal open onClose={onClose} title="Цалингийн цоожны код" subtitle="Цоожтой цалинг тайлахад шаардана. Шифрлэгдэж хадгалагдана." footer={<><Button onClick={onClose}>Болих</Button><Button variant="primary" onClick={() => void go()}>Хадгалах</Button></>}>
      <input data-autofocus type="password" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Шинэ код (4–32 тэмдэгт)" aria-label="Шинэ код" className="h-11 w-full rounded-xl border border-line bg-surface px-3" />
      {err ? <div className="mt-2"><Notice>{err}</Notice></div> : null}
    </Modal>
  );
}

// ───────────────────────── Ажлын хуваарь ─────────────────────────

const DAY_SHORT: Record<string, string> = { LEAVE: 'Ч', SICK: 'Ө', ABSENT: 'Т', DAY_OFF: 'АМ' };
const DAY_TONE: Record<string, string> = { LEAVE: 'bg-info-soft text-info', SICK: 'bg-warn-soft text-warn', ABSENT: 'bg-bad-soft text-bad-ink', DAY_OFF: 'bg-surface2 text-muted' };
function ScheduleTab({ ym, rows, onErr }: { ym: string; rows: BoardRow[]; onErr: (s: string) => void }) {
  const [d, setD] = useState<{ daysInMonth: number; labels: Record<string, string>; days: { staffKey: string; date: string; dayType: string }[] } | null>(null);
  const [mark, setMark] = useState('LEAVE');
  const [q, setQ] = useState('');
  const load = useCallback(async () => { try { setD(await api(`/api/salary?schedule=${ym}`)); } catch (e) { onErr(msg(e)); } }, [ym, onErr]);
  useEffect(() => { void load(); }, [load]);
  const map = useMemo(() => new Map((d?.days ?? []).map((x) => [`${x.staffKey}|${x.date}`, x.dayType])), [d]);
  const toggle = async (key: string, date: string) => {
    const cur = map.get(`${key}|${date}`);
    try { await api('/api/salary', { method: 'POST', json: { action: 'workday', staffKey: key, date, dayType: cur === mark ? '' : mark } }); await load(); } catch (e) { onErr(msg(e)); }
  };
  if (!d) return null;
  const days = Array.from({ length: d.daysInMonth }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`);
  const list = rows.filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <section className="overflow-hidden rounded-[20px] border border-line bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="text-[13px] font-bold">Тэмдэглэх:</span>
        {Object.entries(d.labels).map(([k, l]) => <button key={k} onClick={() => setMark(k)} className={clsx('h-8 rounded-full px-3 text-[12.5px] font-bold', mark === k ? 'ring-2 ring-ink' : '', DAY_TONE[k])}>{DAY_SHORT[k]} · {l}</button>)}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ажилтан хайх" className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-3 text-[13px] sm:ml-auto sm:w-[160px] sm:flex-none" aria-label="Ажилтан хайх" />
      </div>
      <p className="px-3 pt-2 text-[12px] text-subtle">Нүдэнд дарахад сонгосон төрөл тэмдэглэгдэнэ, дахин дарахад арилна (= ажилласан). Цоожтой хугацааг засахгүй.</p>
      <div className="overflow-x-auto p-3">
        <table className="text-[12px]">
          <thead><tr><th className="sticky left-0 z-10 min-w-[150px] bg-surface pr-2 text-left font-semibold text-muted">Ажилтан</th>{days.map((x) => <th key={x} className="w-7 text-center font-semibold text-subtle">{Number(x.slice(8))}</th>)}<th className="pl-2 text-right font-semibold text-muted">Нийт</th></tr></thead>
          <tbody>
            {list.map((r) => {
              const n = days.filter((x) => map.has(`${r.key}|${x}`)).length;
              return (
                <tr key={r.key}>
                  <td className="sticky left-0 z-10 max-w-[180px] truncate bg-surface pr-2 font-semibold" title={r.name}>{r.name}</td>
                  {days.map((x) => { const t = map.get(`${r.key}|${x}`); return <td key={x} className="p-0.5"><button onClick={() => void toggle(r.key, x)} className={clsx('h-7 w-7 rounded-md text-[11px] font-bold', t ? DAY_TONE[t] : 'bg-surface2 text-subtle hover:bg-line')} title={t ? d.labels[t] : 'Ажилласан'}>{t ? DAY_SHORT[t] : '·'}</button></td>; })}
                  <td className="pl-2 text-right text-muted">{n ? `${n} өдөр` : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ───────────────────────── Ажилтны өр ─────────────────────────

function DebtsTab({ rows, onErr }: { rows: BoardRow[]; onErr: (s: string) => void }) {
  const [d, setD] = useState<{ items: { id: number; staffName: string; description: string; totalAmount: number; remainingAmount: number; isActive: boolean; createdAt: string; createdByName: string; payments: { id: number; periodLabel: string; amount: number; createdAt: string }[] }[]; total: number } | null>(null);
  const [f, setF] = useState({ staffKey: '', description: '', amount: '' });
  const load = useCallback(async () => { try { setD(await api('/api/salary?debts=1')); } catch (e) { onErr(msg(e)); } }, [onErr]);
  useEffect(() => { void load(); }, [load]);
  const add = async () => { try { await api('/api/salary', { method: 'POST', json: { action: 'debt', ...f, amount: Number(f.amount) } }); setF({ staffKey: '', description: '', amount: '' }); await load(); } catch (e) { onErr(msg(e)); } };
  return (
    <div className="flex flex-col gap-3">
      <section className="grid gap-2 rounded-[20px] border border-line bg-surface p-3 shadow-card sm:grid-cols-[1fr_1.4fr_140px_auto]">
        <select value={f.staffKey} onChange={(e) => setF({ ...f, staffKey: e.target.value })} className="h-10 min-w-0 rounded-[10px] border border-line bg-surface px-2 text-[13.5px]" aria-label="Ажилтан"><option value="">Ажилтан сонгох</option>{rows.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select>
        <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Өрийн тайлбар (жишээ: урьдчилгаа)" aria-label="Тайлбар" className="h-10 min-w-0 rounded-[10px] border border-line bg-surface px-3" />
        <input value={f.amount} inputMode="numeric" onChange={(e) => setF({ ...f, amount: digits(e.target.value) })} placeholder="Дүн ₮" aria-label="Дүн" className="h-10 min-w-0 rounded-[10px] border border-line bg-surface px-3" />
        <Button variant="primary" disabled={!f.staffKey || !f.amount} onClick={() => void add()}>Өр нэмэх</Button>
      </section>
      <section className="overflow-hidden rounded-[20px] border border-line bg-surface shadow-card">
        <div className="flex justify-between border-b border-line px-4 py-2.5 text-[14px] font-extrabold"><span>Идэвхтэй өр</span><span className="text-bad-ink">{money(d?.total ?? 0)}</span></div>
        <ul className="divide-y divide-line">
          {d?.items.map((x) => (
            <li key={x.id} className="px-4 py-2.5 text-[13.5px]">
              <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="min-w-0 [overflow-wrap:anywhere]"><b>{x.staffName}</b> · {x.description}</span><span className="shrink-0"><b className={x.isActive ? 'text-bad-ink' : 'text-ok-ink'}>{money(x.remainingAmount)}</b> <span className="text-[12px] text-subtle">/ {money(x.totalAmount)}</span></span></div>
              <div className="text-[12px] text-subtle">{ubDateTime(x.createdAt)} · {x.createdByName}{x.payments.length ? ` · төлсөн: ${x.payments.map((p) => `${p.periodLabel} ${money(p.amount)}`).join(', ')}` : ''}</div>
            </li>
          ))}
          {d && !d.items.length ? <li className="px-4 py-10 text-center text-muted">Өр алга</li> : null}
        </ul>
      </section>
    </div>
  );
}
