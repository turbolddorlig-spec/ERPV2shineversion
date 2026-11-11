'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';
import { money } from '@/lib/format';

/**
 * Ахлах жолоочийн «Жолоочийн гүйцэтгэл», «График» (хуучин ERP шиг, хуучны алдааг зассан — #77):
 * хүргэсэн өдрөөр (B1), Улаанбаатарын цагаар; хойшилсон (Маргааш) цуцлалтад орохгүй; амжилт = хүргэсэн ÷ (хүргэсэн + цуцалсан).
 */
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const ubToday = (add = 0) => new Date(Date.now() + 8 * 3600_000 + add * 86_400_000).toISOString().slice(0, 10);
interface Driver { id: string; name: string }
interface PRow { id: string; name: string; phone: string; delivered: number; cancelled: number; postponed: number; total: number; revenue: number; rate: number | null }
interface PResp { from: string; to: string; items: PRow[]; totals: { delivered: number; cancelled: number; postponed: number; total: number; revenue: number; rate: number | null } }
interface CResp { days: number; daily: { date: string; delivered: number; cancelled: number; postponed: number; total: number }[] }

const rateTone = (r: number | null) => (r === null ? 'text-subtle' : r >= 85 ? 'text-ok-ink' : r >= 70 ? 'text-info' : r >= 55 ? 'text-warn' : 'text-bad-ink');
const barTone = (r: number | null) => (r === null ? 'bg-surface2' : r >= 85 ? 'bg-ok' : r >= 70 ? 'bg-info' : r >= 55 ? 'bg-warn' : 'bg-bad');

function DriverPick({ drivers, value, onChange }: { drivers: Driver[]; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-10 min-w-[160px] rounded-[10px] border border-line bg-surface px-2 text-[14px]" aria-label="Жолооч">
      <option value="">Бүх жолооч</option>
      {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
    </select>
  );
}

export function PerformanceTab({ drivers }: { drivers: Driver[] }) {
  const [from, setFrom] = useState(ubToday(-6));
  const [to, setTo] = useState(ubToday());
  const [drv, setDrv] = useState('');
  const [data, setData] = useState<PResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await api(`/api/driver-lead/stats?kind=performance&from=${from}&to=${to}${drv ? `&driverId=${drv}` : ''}`)); setErr(null); } catch (e) { setErr(msg(e)); }
  }, [from, to, drv]);
  useEffect(() => { void load(); }, [load]);
  const t = data?.totals;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2 rounded-[14px] border border-line bg-surface p-3">
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-muted">Эхлэх огноо<input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-10 rounded-[10px] border border-line bg-surface px-2 text-[14px] text-ink" /></label>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-muted">Дуусах огноо<input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-10 rounded-[10px] border border-line bg-surface px-2 text-[14px] text-ink" /></label>
        <DriverPick drivers={drivers} value={drv} onChange={setDrv} />
        {[['Өнөөдөр', 0], ['7 хоног', -6], ['30 хоног', -29]].map(([l, a]) => (
          <Button key={String(l)} size="sm" variant={from === ubToday(Number(a)) && to === ubToday() ? 'dark' : 'secondary'} onClick={() => { setFrom(ubToday(Number(a))); setTo(ubToday()); }}>{l}</Button>
        ))}
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {t ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {([['Нийт', t.total, ''], ['Хүргэсэн', t.delivered, 'text-ok-ink'], ['Цуцалсан', t.cancelled, 'text-bad-ink'], ['Маргааш', t.postponed, 'text-warn'], ['Амжилт', t.rate === null ? '—' : `${t.rate}%`, rateTone(t.rate)]] as const).map(([l, v, c]) => (
            <div key={l} className="rounded-[12px] border border-line bg-surface px-3 py-2"><div className="text-[11.5px] font-semibold text-subtle">{l}</div><div className={clsx('text-[20px] font-extrabold', c)}>{v}</div></div>
          ))}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-[16px] border border-line bg-surface shadow-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13.5px]">
            <thead className="bg-surface2 text-[12px] text-muted"><tr>
              <th className="px-3 py-2 text-left">#</th><th className="px-3 py-2 text-left">Жолооч</th><th className="px-2 py-2 text-right">Нийт</th><th className="px-2 py-2 text-right">Хүргэсэн</th>
              <th className="px-2 py-2 text-right">Цуцалсан</th><th className="px-2 py-2 text-right">Маргааш</th><th className="px-2 py-2 text-right">Хүргэсэн дүн</th><th className="w-[200px] px-3 py-2 text-left">Амжилт</th>
            </tr></thead>
            <tbody className="divide-y divide-line">
              {data?.items.map((r, i) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 text-subtle">{i + 1}</td>
                  <td className="max-w-[220px] px-3 py-2"><b className="block [overflow-wrap:anywhere]">{r.name}</b><span className="text-[12px] text-subtle">{r.phone}</span></td>
                  <td className="px-2 py-2 text-right">{r.total}</td>
                  <td className="px-2 py-2 text-right font-bold text-ok-ink">{r.delivered}</td>
                  <td className="px-2 py-2 text-right text-bad-ink">{r.cancelled || ''}</td>
                  <td className="px-2 py-2 text-right text-warn">{r.postponed || ''}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right">{money(r.revenue)}</td>
                  <td className="px-3 py-2"><div className="flex items-center gap-2"><div className="h-2 flex-1 overflow-hidden rounded-full bg-surface2"><div className={clsx('h-full rounded-full', barTone(r.rate))} style={{ width: `${r.rate ?? 0}%` }} /></div><b className={clsx('w-12 text-right', rateTone(r.rate))}>{r.rate === null ? '—' : `${r.rate}%`}</b></div></td>
                </tr>
              ))}
            </tbody>
            {t && data?.items.length ? (
              <tfoot className="border-t-2 border-line bg-surface2/60 font-bold"><tr>
                <td className="px-3 py-2" colSpan={2}>Нийт дүн</td><td className="px-2 py-2 text-right">{t.total}</td><td className="px-2 py-2 text-right text-ok-ink">{t.delivered}</td>
                <td className="px-2 py-2 text-right text-bad-ink">{t.cancelled}</td><td className="px-2 py-2 text-right text-warn">{t.postponed}</td><td className="whitespace-nowrap px-2 py-2 text-right">{money(t.revenue)}</td>
                <td className={clsx('px-3 py-2', rateTone(t.rate))}>{t.rate === null ? '—' : `${t.rate}%`}</td>
              </tr></tfoot>
            ) : null}
          </table>
        </div>
        {data && !data.items.length ? <p className="px-4 py-10 text-center text-muted">Энэ хугацаанд мэдээлэл алга</p> : null}
      </div>
      <p className="text-[12px] text-subtle">Хүргэсэн — хүргэсэн өдрөөр; Цуцалсан — жолооч / асуудлаар цуцалсан өдрөөр; Маргааш — хойшлуулсан өдрөөр (цуцлалтад орохгүй). Амжилт = хүргэсэн ÷ (хүргэсэн + цуцалсан).</p>
    </div>
  );
}

export function ChartTab({ drivers }: { drivers: Driver[] }) {
  const [days, setDays] = useState(14);
  const [drv, setDrv] = useState('');
  const [data, setData] = useState<CResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<CResp>(`/api/driver-lead/stats?kind=chart&days=${days}${drv ? `&driverId=${drv}` : ''}`).then((r) => { setData(r); setErr(null); }).catch((e) => setErr(msg(e))); }, [days, drv]);
  const series = [
    { k: 'total' as const, l: 'Нийт', c: 'var(--ink)' }, { k: 'delivered' as const, l: 'Хүргэсэн', c: 'var(--ok, #16a34a)' },
    { k: 'cancelled' as const, l: 'Цуцалсан', c: 'var(--bad, #dc2626)' }, { k: 'postponed' as const, l: 'Маргааш', c: 'var(--warn, #d97706)' },
  ];
  const W = 900; const H = 280; const P = { l: 40, r: 28, t: 12, b: 34 };
  const pts = data?.daily ?? [];
  const max = Math.max(1, ...pts.map((d) => d.total));
  const x = (i: number) => P.l + (pts.length > 1 ? (i * (W - P.l - P.r)) / (pts.length - 1) : 0);
  const y = (v: number) => H - P.b - (v * (H - P.t - P.b)) / max;
  const ticks = Array.from(new Set([0, Math.round(max / 2), max]));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-surface p-3">
        <b className="mr-auto text-[15px]">{days} хоногийн график</b>
        {[7, 14, 30].map((d) => <Button key={d} size="sm" variant={days === d ? 'dark' : 'secondary'} onClick={() => setDays(d)}>{d} хоног</Button>)}
        <DriverPick drivers={drivers} value={drv} onChange={setDrv} />
      </div>
      {err ? <Notice>{err}</Notice> : null}
      <div className="rounded-[16px] border border-line bg-surface p-3 shadow-card">
        <div className="mb-2 flex flex-wrap gap-3 text-[12.5px]">{series.map((s) => <span key={s.k} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-5 rounded-full" style={{ background: s.c }} />{s.l}</span>)}</div>
        {pts.every((d) => d.total === 0) ? <p className="py-12 text-center text-muted">Мэдээлэл байхгүй</p> : (
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Өдрийн хүргэлтийн график">
            {ticks.map((v) => <g key={v}><line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="var(--line)" /><text x={P.l - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--subtle)">{v}</text></g>)}
            {pts.map((d, i) => (i % Math.ceil(pts.length / 10) === 0 || i === pts.length - 1 ? <text key={d.date} x={x(i)} y={H - 12} textAnchor="middle" fontSize="11" fill="var(--subtle)">{d.date.slice(5).replace('-', '/')}</text> : null))}
            {series.map((s) => (
              <g key={s.k}>
                <polyline fill="none" stroke={s.c} strokeWidth={s.k === 'total' ? 2 : 2.5} strokeDasharray={s.k === 'total' ? '5 4' : undefined} points={pts.map((d, i) => `${x(i)},${y(d[s.k])}`).join(' ')} />
                {pts.map((d, i) => <circle key={i} cx={x(i)} cy={y(d[s.k])} r={3} fill={s.c}><title>{`${d.date} · ${s.l}: ${d[s.k]}`}</title></circle>)}
              </g>
            ))}
          </svg>
        )}
      </div>
      <div className="overflow-x-auto rounded-[14px] border border-line bg-surface">
        <table className="w-full min-w-[520px] text-[13px]">
          <thead className="bg-surface2 text-[12px] text-muted"><tr><th className="px-3 py-2 text-left">Огноо</th><th className="px-2 py-2 text-right">Нийт</th><th className="px-2 py-2 text-right">Хүргэсэн</th><th className="px-2 py-2 text-right">Цуцалсан</th><th className="px-3 py-2 text-right">Маргааш</th></tr></thead>
          <tbody className="divide-y divide-line">{[...pts].reverse().map((d) => <tr key={d.date}><td className="px-3 py-1.5">{d.date}</td><td className="px-2 py-1.5 text-right">{d.total}</td><td className="px-2 py-1.5 text-right text-ok-ink">{d.delivered}</td><td className="px-2 py-1.5 text-right text-bad-ink">{d.cancelled}</td><td className="px-3 py-1.5 text-right text-warn">{d.postponed}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
