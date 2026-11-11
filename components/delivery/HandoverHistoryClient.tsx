'use client';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';
import { ubDateTime } from '@/lib/format';

interface Row { id: number; number: string; date: string; driverName: string; status: string; statusLabel: string; orders: number; createdByName: string; createdAt: string; handedOverBy: string | null; handedOverAt: string | null }
const ubToday = (add = 0) => new Date(Date.now() + 8 * 3600_000 + add * 86_400_000).toISOString().slice(0, 10);
const TONE: Record<string, string> = { DRAFT: 'bg-surface2 text-muted', PREPARED: 'bg-info-soft text-info', HANDED_OVER: 'bg-warn-soft text-warn', RECEIVED: 'bg-ok-soft text-ok-ink' };

/** Падааны түүх — хуучин шиг: эхлэх/дуусах огноо, жолооч; карт дээр дарахад хэвлэх хуудас шинэ табд */
export function HandoverHistoryClient() {
  const [from, setFrom] = useState(ubToday(-7));
  const [to, setTo] = useState(ubToday());
  const [driverId, setDriverId] = useState('');
  const [drivers, setDrivers] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<{ items: { id: string; name: string }[] }>('/api/driver-lead/drivers').then((r) => setDrivers(r.items)).catch(() => undefined); }, []);
  useEffect(() => {
    setRows(null);
    api<{ items: Row[] }>(`/api/handover?history=1&from=${from}&to=${to}${driverId ? `&driverId=${driverId}` : ''}`).then((r) => setRows(r.items)).catch((e) => setError(e instanceof ApiError ? e.message : 'Алдаа'));
  }, [from, to, driverId]);
  const inp = 'h-10 rounded-lg border border-line bg-surface px-2.5 text-[13px]';
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-muted">Эхлэх<input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className={inp} /></label>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-muted">Дуусах<input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className={inp} /></label>
        <select aria-label="Жолооч" value={driverId} onChange={(e) => setDriverId(e.target.value)} className={inp}><option value="">Бүх жолооч</option>{drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      </div>
      {error ? <Notice>{error}</Notice> : null}
      {!rows ? <p className="py-6 text-center text-muted">Ачаалж байна…</p> : !rows.length ? <p className="rounded-xl bg-surface2 p-8 text-center text-subtle">Падаан алга</p> : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <a key={r.id} href={`/print/handover/${r.id}`} target="_blank" rel="noreferrer" className="flex flex-col gap-1 rounded-xl border border-line bg-surface p-3 hover:bg-surface2/50">
              <span className="flex items-center gap-2"><b className="text-[15px]">{r.number}</b><span className={clsx('rounded-md px-1.5 text-[11.5px] font-bold', TONE[r.status])}>{r.statusLabel}</span><span className="ml-auto text-muted">{r.date}</span></span>
              <span><b>{r.driverName}</b> · {r.orders} захиалга</span>
              <span className="text-[12px] text-subtle">Үүсгэсэн: {r.createdByName} · {ubDateTime(r.createdAt)}</span>
              {r.handedOverAt ? <span className="text-[12px] text-ok-ink">Агуулах өгсөн: {r.handedOverBy} · {ubDateTime(r.handedOverAt)}</span> : null}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
