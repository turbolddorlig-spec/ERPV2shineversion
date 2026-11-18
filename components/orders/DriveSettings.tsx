'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';
import { ubDateTime } from '@/lib/format';

interface D {
  clientId: string; secretSet: boolean; connected: boolean; email: string | null; connectedAt: string | null; connectedBy: string | null;
  redirectUri: string; confWritten: boolean;
  status: { lastOk: string | null; driveOkAt: string | null; driveErrorAt: string | null; driveError: string | null; driveUsedPct: string | null; driveConfigured: boolean } | null;
}
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');

/** #171 Нөөц хуулбар — Google Drive холбох (зөвхөн Супер админ) */
export function DriveSettings() {
  const [d, setD] = useState<D | null>(null);
  const [open, setOpen] = useState(false);
  const [guide, setGuide] = useState(false);
  const [f, setF] = useState({ clientId: '', clientSecret: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const load = useCallback(() => api<D>('/api/settings/drive').then((r) => { setD(r); setF({ clientId: r.clientId, clientSecret: '' }); }).catch((e) => setErr(msg(e))), []);
  useEffect(() => { void load(); }, [load]);
  // Google-ээс буцсаны дараах үр дүн (?drive=ok|error)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (window.location.hash === '#drive' || p.get('drive')) setOpen(true);
    if (p.get('drive') === 'ok') setOk(`Google Drive холбогдлоо ✓ ${p.get('email') ?? ''} — өнөө шөнө 03:00-д хуулна, эсвэл «Одоо хуулбар авах» дарна уу.`);
    if (p.get('drive') === 'error') setErr(p.get('msg') ?? 'Холбогдсонгүй');
    if (p.get('drive')) window.history.replaceState(null, '', '/settings#drive');
  }, []);

  async function call(key: string, json: Record<string, unknown>, done: string) {
    setBusy(key); setErr(null); setOk(null);
    try {
      const r = await api<{ ok?: boolean; info?: string }>('/api/settings/drive', { method: 'POST', json });
      if (key === 'test') { if (r.ok) setOk(`Холболт хэвийн ✓ ${r.info ?? ''}`); else setErr(r.info ?? 'Холболт алдаатай'); }
      else setOk(done);
      await load();
    } catch (e) { setErr(msg(e)); } finally { setBusy(null); }
  }
  const copy = async (t: string) => { try { await navigator.clipboard.writeText(t); setOk('Хуулагдлаа'); } catch { /* */ } };
  if (!d) return err ? <Notice>{err}</Notice> : null;
  const st = d.status;
  const lastErr = st?.driveErrorAt && (!st.driveOkAt || st.driveErrorAt > st.driveOkAt);

  return (
    <section id="drive" className="mt-4 flex min-w-0 flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
      <button type="button" data-drive-toggle aria-expanded={open} onClick={() => setOpen(!open)} className="-m-1 flex flex-wrap items-center gap-2 rounded-xl p-1 text-left hover:bg-surface2">
        <span aria-hidden className="w-4 text-[13px] text-muted">{open ? '▾' : '▸'}</span>
        <h2 className="text-[16px] font-extrabold">Нөөц хуулбар — Google Drive</h2>
        {d.connected ? <Badge tone="ok">Холбогдсон</Badge> : <Badge tone="warn">Холбогдоогүй</Badge>}
        {lastErr ? <Badge tone="bad">Сүүлийн хуулалт алдаатай</Badge> : null}
        <span className="ml-auto text-[13px] font-semibold text-muted">{open ? 'Хаах' : 'Нээх'}</span>
      </button>
      {open ? (<>
        <p className="text-[13px] text-subtle">Database-ийн хуулбарыг өдөр бүр 03:00-д Google Drive-ийн «zahialga-backup» хавтас руу хуулна (7 өдөр, 4 долоо хоног, 12 сар). Систем зөвхөн өөрийн үүсгэсэн хуулбар файлд хүрнэ — таны бусад Drive файлд хүрэхгүй. Зөвхөн Супер админ.</p>
        {err ? <Notice>{err}</Notice> : null}
        {ok ? <Notice tone="ok">{ok}</Notice> : null}

        {d.connected ? (
          <div className="flex flex-col gap-1 rounded-xl border border-line bg-surface2 p-3 text-[13.5px]">
            <div><span className="text-muted">Бүртгэл:</span> <b className="[overflow-wrap:anywhere]">{d.email || '—'}</b></div>
            <div className="text-muted">Холбосон: {d.connectedAt ? ubDateTime(d.connectedAt) : '—'}{d.connectedBy ? ` · ${d.connectedBy}` : ''}</div>
            {st ? <div className="text-muted">Сүүлд Drive-д хуулсан: {st.driveOkAt ? ubDateTime(st.driveOkAt) : 'хараахан үгүй'}{st.driveUsedPct ? ` · Drive ${st.driveUsedPct}% дүүрсэн` : ''}</div> : null}
            {lastErr ? <div className="text-bad-ink [overflow-wrap:anywhere]">Алдаа ({ubDateTime(st!.driveErrorAt!)}): {st!.driveError}</div> : null}
          </div>
        ) : null}

        <button type="button" onClick={() => setGuide(!guide)} className="self-start text-[13px] font-semibold text-muted underline">{guide ? '▾' : '▸'} Анх удаа: Client ID, Secret хэрхэн авах вэ (10 минут, нэг удаа)</button>
        {guide ? (
          <ol className="flex list-decimal flex-col gap-1.5 rounded-xl border border-line p-3 pl-8 text-[13.5px] [overflow-wrap:anywhere]">
            <li><b>console.cloud.google.com</b> руу хуулбар хадгалах Google бүртгэлээрээ нэвтэрнэ → дээд талын «Select a project» → <b>New project</b> (нэр: zahialga-backup) → Create.</li>
            <li>Хайлтад <b>Google Drive API</b> гэж бичээд → <b>Enable</b>.</li>
            <li><b>APIs &amp; Services → OAuth consent screen</b> (эсвэл «Google Auth Platform») → Get started → App name: zahialga, имэйлээ сонгоно → Audience: <b>External</b> → дуусгана. Дараа нь «Audience» хэсэгт <b>Publish app</b> дарна (эс бөгөөс 7 хоногийн дараа холболт тасарна).</li>
            <li><b>Clients → Create client</b> → Application type: <b>Web application</b> → «Authorized redirect URIs» хэсэгт доорх хаягийг яг хуулж нэмнэ → Create.</li>
            <li>Гарсан <b>Client ID</b>, <b>Client secret</b>-ийг доорх талбарт хуулж <b>Хадгалах</b> → <b>Google Drive холбох</b>. «Google hasn’t verified this app» гарвал «Advanced → Go to zahialga» → Зөвшөөрөх.</li>
          </ol>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-semibold text-muted">Буцах хаяг (Authorized redirect URI)</span>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <code data-drive-redirect className="min-w-0 flex-1 rounded-xl border border-line bg-surface2 px-3 py-2.5 text-[13px] [overflow-wrap:anywhere]">{d.redirectUri}</code>
            <Button size="sm" onClick={() => void copy(d.redirectUri)}>Хуулах</Button>
          </div>
          {d.redirectUri.startsWith('http://') && !d.redirectUri.includes('localhost') ? <p className="text-[12.5px] text-warn">Google зөвхөн https:// хаяг (домэйн) зөвшөөрнө — серверт домэйн тохируулсан байх шаардлагатай.</p> : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="drive-client-id" label="Client ID" value={f.clientId} placeholder="….apps.googleusercontent.com" onChange={(e) => setF({ ...f, clientId: e.target.value })} />
          <Field id="drive-client-secret" label="Client secret" type="password" autoComplete="off" value={f.clientSecret} placeholder={d.secretSet ? 'Хадгалсан — солих үед л бичнэ' : ''} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button loading={busy === 'client'} onClick={() => call('client', { kind: 'client', clientId: f.clientId, ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}) }, 'Хадгаллаа')}>Хадгалах</Button>
          {d.clientId && d.secretSet
            ? <a href="/api/settings/drive/connect" data-drive-connect className="inline-flex h-11 items-center rounded-[11px] bg-accent px-4 text-[14px] font-bold text-on-accent md:h-10">{d.connected ? 'Өөр Drive холбох' : 'Google Drive холбох'}</a>
            : null}
          {d.connected ? <>
            <Button loading={busy === 'test'} onClick={() => call('test', { kind: 'test' }, '')}>Шалгах</Button>
            <Button loading={busy === 'now'} onClick={() => call('now', { kind: 'backup-now' }, 'Хүсэлт илгээлээ — 1–2 минутын дотор хуулбар авч Drive руу хуулна. Дараа нь энэ хуудсыг шинэчилж «Сүүлд Drive-д хуулсан»-ыг харна уу.')}>Одоо хуулбар авах</Button>
            <Button variant="danger" loading={busy === 'off'} onClick={() => { if (confirm('Google Drive-ийг салгах уу? Хуулбар зөвхөн серверт үлдэнэ.')) void call('off', { kind: 'disconnect' }, 'Салгалаа'); }}>Салгах</Button>
          </> : null}
        </div>
      </>) : null}
    </section>
  );
}
