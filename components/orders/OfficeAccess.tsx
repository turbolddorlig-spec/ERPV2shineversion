'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Badge } from '@/components/ui/Badge';
import { api, ApiError } from '@/components/ui/api';

/** Тохиргоо → «Зөвхөн ажлын байрнаас нэвтрэх» (#86): сонгосон ролууд зөвхөн ажлын интернэтийн IP-аас; IP бүртгээгүй бол хаанаас ч болно */
interface Resp { enabled: boolean; roles: string[]; ips: { ip: string; label: string }[]; currentIp: string | null; roleOptions: { role: string; label: string }[] }
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');

export function OfficeAccess() {
  const [d, setD] = useState<Resp | null>(null);
  const [f, setF] = useState<{ enabled: boolean; roles: string[]; ips: { ip: string; label: string }[] }>({ enabled: false, roles: [], ips: [] });
  const [newIp, setNewIp] = useState({ ip: '', label: '' });
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { const r = await api<Resp>('/api/settings/office'); setD(r); setF({ enabled: r.enabled, roles: r.roles, ips: r.ips }); } catch (e) { setErr(msg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    setBusy(true); setErr(null); setOk(null);
    try { await api('/api/settings/office', { method: 'POST', json: f }); setOk(f.enabled ? 'Хадгалагдлаа — сонгосон ажилтнууд зөвхөн ажлын интернэтээс нэвтэрнэ' : 'Хадгалагдлаа — хязгаарлалт унтраалттай (хаанаас ч нэвтэрнэ)'); await load(); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const addIp = (ip: string, label: string) => {
    const v = ip.trim();
    if (!v || f.ips.some((x) => x.ip === v)) return;
    setF({ ...f, ips: [...f.ips, { ip: v, label: label.trim() }] }); setNewIp({ ip: '', label: '' });
  };
  if (!d) return err ? <Notice>{err}</Notice> : <p className="text-muted">Ачаалж байна…</p>;
  const onList = !!d.currentIp && f.ips.some((x) => x.ip === d.currentIp);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {d.enabled && d.ips.length ? <Badge tone="ok">Асаалттай</Badge> : <Badge>Унтраалттай — хаанаас ч нэвтэрнэ</Badge>}
        <span className="text-[12.5px] text-subtle">Таны одоогийн IP: <b className="text-ink">{d.currentIp ?? 'тодорхойгүй'}</b>{onList ? ' (ажлын жагсаалтад байгаа)' : ''}</span>
      </div>
      <label className="flex items-center gap-2 text-[14px] font-semibold"><input type="checkbox" className="h-5 w-5" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />Сонгосон ажилтнууд зөвхөн ажлын байрнаас нэвтэрнэ</label>
      <div>
        <div className="mb-1 text-[13px] font-semibold text-muted">Хэнд хамаарах (сонгоогүй рольтой нь хаанаас ч)</div>
        <div className="flex flex-wrap gap-2">
          {d.roleOptions.map((r) => (
            <label key={r.role} className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] font-semibold">
              <input type="checkbox" className="h-4 w-4" checked={f.roles.includes(r.role)} onChange={(e) => setF({ ...f, roles: e.target.checked ? [...f.roles, r.role] : f.roles.filter((x) => x !== r.role) })} />{r.label}
            </label>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1 text-[13px] font-semibold text-muted">Ажлын интернэтийн IP хаяг</div>
        <ul className="divide-y divide-line rounded-[12px] border border-line">
          {f.ips.map((x) => (
            <li key={x.ip} className="flex items-center justify-between gap-2 px-3 py-2 text-[13.5px]">
              <span className="min-w-0 [overflow-wrap:anywhere]"><b>{x.ip}</b>{x.label ? <span className="text-muted"> · {x.label}</span> : null}</span>
              <button onClick={() => setF({ ...f, ips: f.ips.filter((y) => y.ip !== x.ip) })} className="shrink-0 text-[12.5px] font-semibold text-bad-ink">Хасах</button>
            </li>
          ))}
          {!f.ips.length ? <li className="px-3 py-3 text-center text-[13px] text-muted">IP бүртгээгүй — ажил дээрээ байхдаа «Одоогийн IP-г нэмэх» дарна уу</li> : null}
        </ul>
        <div className="mt-2 flex flex-wrap gap-2">
          {d.currentIp && !onList ? <Button size="sm" variant="dark" onClick={() => addIp(d.currentIp!, 'Ажлын байр')}>Одоогийн IP-г нэмэх ({d.currentIp})</Button> : null}
          <input value={newIp.ip} onChange={(e) => setNewIp({ ...newIp, ip: e.target.value })} placeholder="IP (жишээ 202.21.100.5)" className="h-9 w-[180px] rounded-[10px] border border-line bg-surface px-2 text-[13.5px]" aria-label="IP хаяг" />
          <input value={newIp.label} onChange={(e) => setNewIp({ ...newIp, label: e.target.value })} placeholder="Тайлбар (Оффис 2 давхар)" maxLength={60} className="h-9 w-[180px] rounded-[10px] border border-line bg-surface px-2 text-[13.5px]" aria-label="Тайлбар" />
          <Button size="sm" onClick={() => addIp(newIp.ip, newIp.label)}>Нэмэх</Button>
        </div>
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
      <div><Button variant="primary" loading={busy} onClick={() => void save()}>Хадгалах</Button></div>
      <p className="text-[12.5px] text-subtle">Ажлын сүлжээнд холбогдсон бол утсаар ч нэвтэрнэ. Ажил дээрээ нэвтэрч гэртээ очвол хуудас нээгдэхгүй. Супер админыг хэзээ ч хязгаарлахгүй. Интернэт үйлчилгээ үзүүлэгч IP-г сольсон бол шинээр нэмнэ.</p>
    </div>
  );
}
