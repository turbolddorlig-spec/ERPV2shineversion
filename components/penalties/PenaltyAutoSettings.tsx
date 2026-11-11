'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';

/** Тохиргоо → Торгуулийн дүн: асуудлаар цуцлахад автоматаар тавигдах торгууль (анх 5,000₮, хуучин шиг) */
const L: [string, string][] = [['OPP_ERROR', 'Опп-н алдаа'], ['MARKETING_ERROR', 'Маркетингийн алдаа'], ['WAREHOUSE_ERROR', 'Агуулахын алдаа']];
export function PenaltyAutoSettings() {
  const [v, setV] = useState<Record<string, string> | null>(null);
  const [can, setCan] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<{ autoAmount: Record<string, number>; canAutoAmount: boolean }>('/api/penalties/config').then((r) => { setV(Object.fromEntries(Object.entries(r.autoAmount).map(([k, x]) => [k, String(x)]))); setCan(r.canAutoAmount); }).catch((e) => setErr(e instanceof ApiError ? e.message : 'Алдаа')); }, []);
  const save = async () => {
    setErr(null); setOk(null);
    try { await api('/api/penalties/config', { method: 'POST', json: { action: 'auto', ...Object.fromEntries(Object.entries(v ?? {}).map(([k, x]) => [k, Number(x)])) } }); setOk('Хадгалагдлаа'); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Алдаа'); }
  };
  if (!v) return err ? <Notice>{err}</Notice> : null;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {L.map(([k, l]) => (
          <label key={k} className="flex flex-col gap-1 text-[13px] font-semibold text-muted">{l} (₮)
            <input inputMode="numeric" disabled={!can} value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value.replace(/\D/g, '') })} className="h-11 rounded-xl border border-line bg-surface px-3 text-[15px] text-ink" /></label>
        ))}
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
      {can ? <div><Button variant="primary" onClick={() => void save()}>Хадгалах</Button></div> : null}
    </div>
  );
}
