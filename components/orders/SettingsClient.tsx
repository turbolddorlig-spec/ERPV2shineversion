'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';

interface Resp {
  settings: { feeUB: number; feeRural: number; waitDays: number; assignHour: number };
  pages: { id: number; name: string; isActive: boolean; sortOrder: number }[];
  meta: { pixelId: string; tokenSet: boolean; tokenHint: string | null; testCode: string; counts: Record<string, number>; recent: { id: number; orderNumber?: string; total?: number; status: string; attempts: number; lastError: string | null; sentAt: string | null; createdAt: string }[] };
}
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const sec = 'flex min-w-0 flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card';
const META_LABEL: Record<string, string> = { PENDING: 'Дараалалд', SENT: 'Илгээсэн', FAILED: 'Алдаатай', SKIPPED: 'Алгассан' };

export function SettingsClient() {
  const [d, setD] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fees, setFees] = useState({ feeUB: '', feeRural: '', waitDays: '', assignHour: '' });
  const [newPage, setNewPage] = useState('');
  const [meta, setMeta] = useState({ pixelId: '', token: '', testCode: '' });
  const load = useCallback(() => api<Resp>('/api/settings/orders').then((r) => {
    setD(r);
    setFees({ feeUB: String(r.settings.feeUB), feeRural: String(r.settings.feeRural), waitDays: String(r.settings.waitDays), assignHour: String(r.settings.assignHour) });
    setMeta({ pixelId: r.meta.pixelId ?? '', token: '', testCode: r.meta.testCode ?? '' });
  }).catch((e) => setError(msg(e))), []);
  useEffect(() => { load(); }, [load]);

  async function post(key: string, json: unknown, ok: string) {
    setBusy(key); setError(null); setFlash(null);
    try { await api('/api/settings/orders', { method: 'POST', json }); setFlash(ok); await load(); return true; } catch (e) { setError(msg(e)); return false; } finally { setBusy(null); }
  }
  if (!d) return error ? <Notice>{error}</Notice> : <p className="text-muted">Ачаалж байна…</p>;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="lg:col-span-2">{flash ? <Notice tone="ok">{flash}</Notice> : null}{error ? <Notice>{error}</Notice> : null}</div>
      <section className={sec}>
        <h2 className="text-[16px] font-extrabold">Хүргэлт ба төлбөр</h2>
        <p className="text-[13px] text-subtle">«Үнэд хүргэлт багтаагүй» бараатай захиалгад нэг удаа нэмэгдэнэ. Оператор шалтгаан бичиж өөрчилж болно.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="feeUB" label="Улаанбаатар (₮)" inputMode="numeric" value={fees.feeUB} onChange={(e) => setFees({ ...fees, feeUB: e.target.value.replace(/\D/g, '') })} />
          <Field id="feeRural" label="Орон нутаг (₮)" inputMode="numeric" value={fees.feeRural} onChange={(e) => setFees({ ...fees, feeRural: e.target.value.replace(/\D/g, '') })} />
          <Field id="waitDays" label="Төлбөр хүлээх хоног" inputMode="numeric" value={fees.waitDays} onChange={(e) => setFees({ ...fees, waitDays: e.target.value.replace(/\D/g, '') })} hint="Орон нутаг: хугацаандаа мөнгө орохгүй бол автоматаар цуцлагдана" />
          <Field id="assignHour" label="Хуваарилалт дуусах цаг (12–23)" inputMode="numeric" value={fees.assignHour} onChange={(e) => setFees({ ...fees, assignHour: e.target.value.replace(/\D/g, '').slice(0, 2) })} hint="Энэ цагаас хойш өнөөдрийн «Шинэ» захиалга хуваарилагдаагүй бол ахлах, админд улаан сануулга" />
        </div>
        <Button variant="primary" className="self-start" loading={busy === 'fees'} onClick={() => post('fees', { kind: 'fees', feeUB: Number(fees.feeUB), feeRural: Number(fees.feeRural), waitDays: Number(fees.waitDays), assignHour: Number(fees.assignHour) }, 'Хадгаллаа')}>Хадгалах</Button>
      </section>

      <section className={sec}>
        <h2 className="text-[16px] font-extrabold">Facebook пэйжүүд</h2>
        <ul className="flex flex-col divide-y divide-line">
          {d.pages.map((p) => <PageRow key={p.id} p={p} busy={busy === `p${p.id}`} onSave={(json) => post(`p${p.id}`, { kind: 'page', id: p.id, ...json }, 'Пэйж хадгаллаа')} />)}
        </ul>
        <div className="flex gap-2">
          <input aria-label="Шинэ пэйжийн нэр" value={newPage} onChange={(e) => setNewPage(e.target.value)} placeholder="Шинэ пэйжийн нэр" className="h-11 flex-1 rounded-xl border border-line bg-surface px-3.5 outline-none focus:border-accent" />
          <Button variant="dark" loading={busy === 'newpage'} disabled={newPage.trim().length < 2} onClick={async () => { if (await post('newpage', { kind: 'page', name: newPage, sortOrder: d.pages.length }, 'Пэйж нэмлээ')) setNewPage(''); }}>Нэмэх</Button>
        </div>
      </section>

      <section className={clsx(sec, 'lg:col-span-2')}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[16px] font-extrabold">Meta (Facebook) Conversions API</h2>
          {d.meta.pixelId && d.meta.tokenSet ? <Badge tone="ok">Холбогдсон</Badge> : <Badge tone="neutral">Тохируулаагүй — илгээхгүй</Badge>}
        </div>
        <p className="text-[13px] text-subtle">Захиалга баталгаажихад (Шинэ болоход) Meta руу «Purchase» мэдээ нэг удаа илгээнэ. Утасны дугаарыг шифрлэж (hash) явуулна. Токен хадгалсны дараа дахин харагдахгүй.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="pixel" label="Pixel (Dataset) ID" inputMode="numeric" value={meta.pixelId} onChange={(e) => setMeta({ ...meta, pixelId: e.target.value.replace(/\D/g, '') })} />
          <Field id="token" label="Access Token" type="password" autoComplete="off" value={meta.token} placeholder={d.meta.tokenHint ? `Хадгалсан ${d.meta.tokenHint}` : ''} onChange={(e) => setMeta({ ...meta, token: e.target.value })} hint="Солих бол шинээр оруулна" />
          <Field id="testcode" label="Test event code (заавал биш)" value={meta.testCode} onChange={(e) => setMeta({ ...meta, testCode: e.target.value })} hint="Туршилтын үед л; дараа нь хоосолно" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy === 'meta'} onClick={async () => { if (await post('meta', { kind: 'meta', pixelId: meta.pixelId, token: meta.token || undefined, testCode: meta.testCode }, 'Meta тохиргоо хадгаллаа')) setMeta((m) => ({ ...m, token: '' })); }}>Хадгалах</Button>
          {d.meta.counts.FAILED ? <Button loading={busy === 'retry'} onClick={() => post('retry', { kind: 'meta-retry' }, 'Алдаатайг дахин дараалалд орууллаа')}>Алдаатай {d.meta.counts.FAILED}-г дахин илгээх</Button> : null}
        </div>
        <div className="flex flex-wrap gap-2 text-[13px]">{Object.entries(META_LABEL).map(([k, l]) => <Badge key={k} tone={k === 'SENT' ? 'ok' : k === 'FAILED' ? 'bad' : 'neutral'}>{l}: {d.meta.counts[k] ?? 0}</Badge>)}</div>
        {d.meta.recent.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead className="text-left text-muted"><tr><th className="py-1.5">Захиалга</th><th>Дүн</th><th>Төлөв</th><th>Оролдлого</th><th>Огноо</th><th>Алдаа</th></tr></thead>
              <tbody className="divide-y divide-line">
                {d.meta.recent.map((r) => (
                  <tr key={r.id}><td className="py-1.5 font-bold">№{r.orderNumber}</td><td>{r.total !== undefined ? money(r.total) : ''}</td><td>{META_LABEL[r.status] ?? r.status}</td><td>{r.attempts}</td><td>{ubDateTime(r.sentAt ?? r.createdAt)}</td><td className="max-w-[260px] truncate text-bad-ink" title={r.lastError ?? ''}>{r.lastError}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function PageRow({ p, busy, onSave }: { p: Resp['pages'][number]; busy: boolean; onSave: (j: { name: string; isActive?: boolean }) => void }) {
  const [name, setName] = useState(p.name);
  useEffect(() => setName(p.name), [p.name]);
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <input aria-label="Пэйжийн нэр" value={name} onChange={(e) => setName(e.target.value)} className={clsx('h-10 min-w-[160px] flex-1 rounded-xl border border-line bg-surface px-3 outline-none focus:border-accent', !p.isActive && 'text-subtle line-through')} />
      {name.trim() !== p.name ? <Button size="sm" variant="dark" loading={busy} onClick={() => onSave({ name })}>Хадгалах</Button> : null}
      <Button size="sm" variant={p.isActive ? 'ghost' : 'secondary'} loading={busy} onClick={() => onSave({ name: p.name, isActive: !p.isActive })}>{p.isActive ? 'Идэвхгүй болгох' : 'Идэвхжүүлэх'}</Button>
    </li>
  );
}
