'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/shell/AppShell';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';

/**
 * Хянах самбар (#123): анхаарах зүйлс · 6 карт · чиг хандлага · цуцлалтын шалтгаан.
 * Захиалгын өдрөөр (Улаанбаатар), төлбөр хүлээж буй орохгүй. 60 сек тутам шинэчлэгдэнэ.
 */
type Range = 'day' | 'week' | 'month';
interface Day { date: string; total: number; delivered: number; cancelled: number; inDelivery: number; waiting: number; postponed: number }
interface Summary {
  range: Range; from: string; to: string;
  kpi: { total: number; delivered: number; cancelled: number; inDelivery: number; waiting: number; postponed: number; successRate: number; cancelRate: number };
  trend: Day[];
  reasons: { key: string; label: string; n: number; pct: number }[];
  cancelledProducts: { productId: number; code: string; name: string; orders: number; qty: number }[];
}
interface Attention { items: { key: string; tone: 'bad' | 'warn' | 'info'; icon: string; label: string; n: number; href: string }[] }

const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const ubToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
const num = (n: number) => n.toLocaleString('en-US');
const clock = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(11, 19);

export function DashboardClient() {
  const [range, setRange] = useState<Range>('day');
  const [date, setDate] = useState(ubToday());
  const [s, setS] = useState<Summary | null>(null);
  const [att, setAtt] = useState<Attention | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<Date | null>(null);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [a, b] = await Promise.all([
        api<Summary>(`/api/dashboard?view=summary&range=${range}&date=${date}`),
        api<Attention>('/api/dashboard?view=attention'),
      ]);
      setS(a); setAtt(b); setErr(null); setAt(new Date());
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  }, [range, date]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setInterval(() => void load(), 60_000); return () => clearInterval(t); }, [load]);
  const isToday = date === ubToday();
  const period = s ? (s.from === s.to ? (isToday ? 'Өнөөдөр' : md(s.to)) : `${md(s.from)} – ${md(s.to)}`) : '';

  return (
    <>
      <PageHeader title="Хянах самбар" subtitle={<>Захиалгын өдрөөр (Улаанбаатар) · төлбөр хүлээж буй орохгүй{at ? ` · сүүлд ${clock(at)}, 60 сек тутам` : ''}</>}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" aria-label="Огноо" value={date} max={ubToday()} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-10 rounded-[10px] border border-line bg-surface px-2.5 text-[13.5px]" />
            <div className="flex gap-1 rounded-xl bg-surface2 p-1">
              {([['day', isToday ? 'Өнөөдөр' : '1 өдөр'], ['week', '7 хоног'], ['month', '30 хоног']] as const).map(([k, l]) => (
                <button key={k} type="button" data-range={k} onClick={() => setRange(k)} className={clsx('rounded-lg px-3 py-1.5 text-[13px] font-semibold', range === k ? 'bg-surface text-ink shadow-sm' : 'text-muted')}>{l}</button>
              ))}
            </div>
            <Button size="sm" onClick={() => void load()} disabled={busy}>{busy ? 'Ачаалж…' : 'Шинэчлэх'}</Button>
          </div>
        )} />
      <div className="flex flex-col gap-4">
        {err ? <Notice>{err}</Notice> : null}
        {att && att.items.length ? (
          <section aria-label="Анхаарах зүйлс" className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {att.items.map((x) => (
              <Link key={x.key} href={x.href} data-attention={x.key}
                className={clsx('flex min-w-0 items-center gap-3 rounded-2xl border px-4 py-3 hover:brightness-95',
                  x.tone === 'bad' ? 'border-bad/40 bg-bad-soft text-bad-ink' : x.tone === 'warn' ? 'border-warn/40 bg-warn-soft text-warn' : 'border-line bg-surface text-ink')}>
                <span className="text-[18px]">{x.icon}</span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere] text-[13.5px] font-semibold">{x.label}</span>
                <b className="shrink-0 text-[20px]">{num(x.n)}</b>
              </Link>
            ))}
          </section>
        ) : att ? <p className="rounded-2xl border border-line bg-surface px-4 py-3 text-[13.5px] text-muted">✓ Анхаарах зүйл алга</p> : null}

        {s ? (<>
          <section aria-label={`Захиалга · ${period}`} className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Нийт захиалга" value={num(s.kpi.total)} sub={`${period}${s.kpi.waiting ? ` · хүлээгдэж ${num(s.kpi.waiting)}` : ''}`} />
            <Kpi label="Хүргэсэн" value={num(s.kpi.delivered)} tone="ok" />
            <Kpi label="Цуцлагдсан" value={num(s.kpi.cancelled)} tone="bad" sub={s.kpi.postponed ? `үүнээс хойшлуулсан ${num(s.kpi.postponed)}` : undefined} />
            <Kpi label="Хүргэлтэд" value={num(s.kpi.inDelivery)} tone="warn" />
            <Kpi label="Амжилт" value={`${s.kpi.successRate}%`} tone="ok" sub={s.kpi.total ? (s.kpi.successRate >= 90 ? 'Сайн' : s.kpi.successRate >= 80 ? 'Дунд' : 'Сайжруулах') : '—'} />
            <Kpi label="Цуцлалт" value={`${s.kpi.cancelRate}%`} tone="bad" sub={s.kpi.total ? (s.kpi.cancelRate <= 5 ? 'Маш сайн' : s.kpi.cancelRate <= 10 ? 'Хэвийн' : 'Анхаар!') : '—'} />
          </section>
          {s.trend.length > 1 ? <Trend days={s.trend} /> : null}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Reasons s={s} />
            <section className="rounded-2xl border border-line bg-surface p-4">
              <h2 className="mb-2 text-[15px] font-bold">Хамгийн их цуцлагдсан бараа</h2>
              {s.cancelledProducts.length ? (
                <div className="overflow-x-auto"><table className="w-full min-w-[320px] text-[13px]">
                  <thead><tr className="text-[12px] text-muted"><th className="py-1 text-left">Бараа</th><th className="px-2 text-right">Захиалга</th><th className="px-2 text-right">Ширхэг</th></tr></thead>
                  <tbody>{s.cancelledProducts.map((p) => (
                    <tr key={p.productId} className="border-t border-line"><td className="max-w-[260px] py-1.5"><div className="line-clamp-2 [overflow-wrap:anywhere] font-semibold" title={p.name}>{p.name}</div><div className="text-[11.5px] text-muted">{p.code}</div></td><td className="px-2 text-right font-bold">{num(p.orders)}</td><td className="px-2 text-right">{num(p.qty)}</td></tr>
                  ))}</tbody>
                </table></div>
              ) : <p className="text-[13px] text-muted">Цуцлагдсан захиалга алга</p>}
            </section>
          </div>
        </>) : !err ? <p className="text-muted">Ачаалж байна…</p> : null}
      </div>
    </>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'bad' | 'warn' }) {
  return (
    <div data-kpi={label} className="flex min-w-0 flex-col gap-1 rounded-2xl border border-line bg-surface p-3.5">
      <span className="text-[12px] font-semibold text-muted">{label}</span>
      <b className={clsx('text-[24px] font-extrabold leading-none tracking-tight', tone === 'ok' && 'text-ok-ink', tone === 'bad' && 'text-bad-ink', tone === 'warn' && 'text-warn')}>{value}</b>
      {sub ? <span className="[overflow-wrap:anywhere] text-[11.5px] text-muted">{sub}</span> : null}
    </div>
  );
}

/** Өдөр бүрийн хүргэсэн / цуцлагдсан (бүлэг багана). Цуцлагдсан нь судалтай — өнгөөр л ялгахгүй. */
function Trend({ days }: { days: Day[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const W = 760, H = 220, L = 36, B = 22, T = 8;
  const max = useMemo(() => { const m = Math.max(1, ...days.map((d) => Math.max(d.delivered, d.cancelled))); const step = niceStep(m); return Math.ceil(m / step) * step; }, [days]);
  const ticks = useMemo(() => { const st = niceStep(max); const a: number[] = []; for (let v = 0; v <= max; v += st) a.push(v); return a; }, [max]);
  const slot = (W - L) / days.length;
  const bw = Math.max(2, Math.min(18, (slot - 6) / 2 - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const every = days.length > 14 ? 5 : 1;
  const h = hover !== null ? days[hover] : null;
  return (
    <section className="rounded-2xl border border-line bg-surface p-4" aria-label="Чиг хандлага">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-bold">Чиг хандлага</h2>
        <div className="flex items-center gap-3 text-[12.5px] text-muted">
          <span className="flex items-center gap-1.5"><svg width="12" height="12" aria-hidden><rect width="12" height="12" rx="2" fill="var(--chart-ok)" /></svg>Хүргэсэн</span>
          <span className="flex items-center gap-1.5"><svg width="12" height="12" aria-hidden><rect width="12" height="12" rx="2" fill="url(#dash-stripe)" /></svg>Цуцлагдсан</span>
          <button type="button" onClick={() => setTable(!table)} className="font-semibold text-accent">{table ? 'График' : 'Хүснэгт'}</button>
        </div>
      </div>
      <svg width="0" height="0" className="absolute" aria-hidden>
        <defs><pattern id="dash-stripe" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="var(--chart-bad)" /><line x1="0" y1="0" x2="0" y2="5" stroke="var(--surface)" strokeWidth="1.6" /></pattern></defs>
      </svg>
      {table ? (
        <div className="max-h-[320px] overflow-auto"><table className="w-full text-[13px]">
          <thead><tr className="text-[12px] text-muted"><th className="py-1 text-left">Өдөр</th><th className="px-2 text-right">Нийт</th><th className="px-2 text-right">Хүргэсэн</th><th className="px-2 text-right">Цуцлагдсан</th><th className="px-2 text-right">Хүргэлтэд</th></tr></thead>
          <tbody>{[...days].reverse().map((d) => <tr key={d.date} className="border-t border-line"><td className="py-1">{md(d.date)}</td><td className="px-2 text-right font-bold">{num(d.total)}</td><td className="px-2 text-right">{num(d.delivered)}</td><td className="px-2 text-right">{num(d.cancelled)}</td><td className="px-2 text-right">{num(d.inDelivery)}</td></tr>)}</tbody>
        </table></div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Өдөр бүрийн хүргэсэн ба цуцлагдсан захиалга" onMouseLeave={() => setHover(null)}>
            {ticks.map((v) => <g key={v}><line x1={L} x2={W} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" /><text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--subtle)">{num(v)}</text></g>)}
            {days.map((d, i) => {
              const x0 = L + i * slot + (slot - (bw * 2 + 2)) / 2;
              return (
                <g key={d.date}>
                  {hover === i ? <rect x={L + i * slot} y={T} width={slot} height={H - T - B} fill="var(--surface2)" /> : null}
                  <Bar x={x0} w={bw} y0={y(0)} y1={y(d.delivered)} fill="var(--chart-ok)" />
                  <Bar x={x0 + bw + 2} w={bw} y0={y(0)} y1={y(d.cancelled)} fill="url(#dash-stripe)" />
                  {i % every === 0 || i === days.length - 1 ? <text x={L + i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--subtle)">{md(d.date)}</text> : null}
                  <rect x={L + i * slot} y={T} width={slot} height={H - T} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
                </g>
              );
            })}
            <line x1={L} x2={W} y1={y(0)} y2={y(0)} stroke="var(--subtle)" strokeWidth="1" />
          </svg>
          {h ? (
            <div className="pointer-events-none absolute top-1 rounded-xl border border-line bg-surface px-3 py-2 text-[12.5px] shadow-lg"
              style={{ left: `clamp(0px, calc(${((L + (hover! + 0.5) * slot) / W) * 100}% - 70px), calc(100% - 150px))` }}>
              <b>{md(h.date)}</b> · нийт {num(h.total)}
              <div className="flex items-center gap-1.5"><svg width="10" height="10" aria-hidden><rect width="10" height="10" rx="2" fill="var(--chart-ok)" /></svg>Хүргэсэн <b className="ml-auto pl-3">{num(h.delivered)}</b></div>
              <div className="flex items-center gap-1.5"><svg width="10" height="10" aria-hidden><rect width="10" height="10" rx="2" fill="url(#dash-stripe)" /></svg>Цуцлагдсан <b className="ml-auto pl-3">{num(h.cancelled)}</b></div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
/** Дээд талдаа 4px бөөрөнхий, суурьтаа шулуун багана */
function Bar({ x, w, y0, y1, fill }: { x: number; w: number; y0: number; y1: number; fill: string }) {
  const hgt = y0 - y1;
  if (hgt <= 0) return null;
  const r = Math.min(4, w / 2, hgt);
  return <path d={`M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 + r} V${y0} Z`} fill={fill} />;
}
function niceStep(max: number) {
  const raw = max / 4; const p = 10 ** Math.floor(Math.log10(raw)); const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function Reasons({ s }: { s: Summary }) {
  const max = Math.max(1, ...s.reasons.map((r) => r.n));
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="mb-2 text-[15px] font-bold">Цуцлалтын шалтгаан <span className="text-[12.5px] font-normal text-muted">· нийт {num(s.kpi.cancelled)}</span></h2>
      {s.reasons.length ? (
        <ul className="flex flex-col gap-2">
          {s.reasons.map((r) => (
            <li key={r.key} data-reason={r.key} className="flex flex-col gap-1">
              <div className="flex justify-between gap-2 text-[13px]"><span className="min-w-0 [overflow-wrap:anywhere]">{r.label}</span><span className="shrink-0"><b>{num(r.n)}</b> <span className="text-muted">· {r.pct}%</span></span></div>
              <div className="h-2 rounded-full bg-surface2"><div className="h-2 rounded-full" style={{ width: `${(r.n / max) * 100}%`, background: 'var(--chart-bad)' }} /></div>
            </li>
          ))}
        </ul>
      ) : <p className="text-[13px] text-muted">Цуцлагдсан захиалга алга</p>}
    </section>
  );
}
