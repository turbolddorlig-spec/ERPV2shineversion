'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';

interface D { name: string; dot: boolean; logoVersion: number | null; text: string; logo: string | null }
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');

/** #177 Лого ба нэр (зөвхөн Супер админ) — tab, зүүн цэс, утас, нэвтрэх хуудас, хэвлэх */
export function BrandSettings() {
  const [d, setD] = useState<D | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(''); const [dot, setDot] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const apply = (r: D) => { setD(r); setName(r.name); setDot(r.dot); };
  const load = useCallback(() => api<D>('/api/settings/brand').then(apply).catch((e) => setErr(msg(e))), []);
  useEffect(() => { void load(); }, [load]);
  // Хадгалсны дараа бүх газарт (цэс, tab) шинэ нэр, лого харагдахын тулд хуудсыг шинэчилнэ
  const done = (m: string) => { setOk(`${m} — хуудас шинэчлэгдэж байна…`); setTimeout(() => window.location.reload(), 900); };
  async function run(key: string, f: () => Promise<D>, m: string) {
    setBusy(key); setErr(null); setOk(null);
    try { apply(await f()); done(m); } catch (e) { setErr(msg(e)); } finally { setBusy(null); }
  }
  // multipart (api() нь JSON толгой тавьдаг тул шууд fetch)
  const upload = (f: File) => run('logo', async () => {
    const fd = new FormData(); fd.append('file', f);
    const res = await fetch('/api/settings/brand', { method: 'POST', body: fd, credentials: 'same-origin' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(j.error ?? 'Алдаа гарлаа', j.code ?? 'error', res.status);
    return j as D;
  }, 'Лого солигдлоо');
  if (!d) return err ? <Notice>{err}</Notice> : null;
  const preview = `${name.trim() || '—'}${dot ? '•' : ''}`;
  return (
    <section id="brand" className="mt-4 flex min-w-0 flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
      <button type="button" data-brand-toggle aria-expanded={open} onClick={() => setOpen(!open)} className="-m-1 flex flex-wrap items-center gap-2 rounded-xl p-1 text-left hover:bg-surface2">
        <span aria-hidden className="w-4 text-[13px] text-muted">{open ? '▾' : '▸'}</span>
        <h2 className="text-[16px] font-extrabold">Лого ба нэр</h2>
        <span className="min-w-0 truncate text-[13px] font-semibold text-muted">{d.text}</span>
        <span className="ml-auto text-[13px] font-semibold text-muted">{open ? 'Хаах' : 'Нээх'}</span>
      </button>
      {open ? (<>
        <p className="text-[13px] text-subtle">Браузерийн tab-ын нэр ба дүрс, зүүн цэсний лого, утасны толгой, нэвтрэх хуудсанд харагдана. Зөвхөн Супер админ.</p>
        {err ? <Notice>{err}</Notice> : null}
        {ok ? <Notice tone="ok">{ok}</Notice> : null}
        {/* Урьдчилан харах */}
        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-line bg-surface2 p-3">
          {d.logo ? <img src={d.logo} alt="Лого" className="h-14 w-14 rounded-[14px] bg-white object-cover" />
            : <span className="grid h-14 w-14 place-items-center rounded-[14px] bg-[#E8590C] text-[28px] font-extrabold text-white">{(name.trim()[0] ?? 'z').toLowerCase()}<span className="text-[#16181D]">.</span></span>}
          <div className="min-w-0 flex-1">
            <div data-brand-preview className="truncate text-[22px] font-extrabold tracking-[-0.03em]">{name.trim() || '—'}{dot ? <span className="text-accent">•</span> : null}</div>
            <div className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-t-lg border border-b-0 border-line bg-surface px-2.5 py-1 text-[12px]">
              {d.logo ? <img src={d.logo} alt="" className="h-4 w-4 rounded-sm" /> : <span className="h-4 w-4 rounded-sm bg-[#E8590C]" />}
              <span className="truncate">Хянах самбар · {preview}</span>
            </div>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="flex min-w-0 flex-col gap-1 text-[13px] font-semibold text-muted">Нэр (1–30 тэмдэгт)
            <input data-brand-input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} className="h-11 rounded-xl border border-line bg-surface px-3 text-[15px] text-ink" />
          </label>
          <label className="flex h-11 items-center gap-2 text-[14px]"><input type="checkbox" checked={dot} onChange={(e) => setDot(e.target.checked)} />Ард нь «•» цэг</label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy === 'name'} disabled={!name.trim() || (name.trim() === d.name && dot === d.dot)} onClick={() => run('name', () => api<D>('/api/settings/brand', { method: 'POST', json: { kind: 'name', name, dot } }), 'Нэр хадгалагдлаа')}>Нэр хадгалах</Button>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
          <Button loading={busy === 'logo'} onClick={() => file.current?.click()}>{d.logo ? 'Лого солих' : 'Лого оруулах'}</Button>
          <Button variant="ghost" loading={busy === 'reset'} disabled={d.name === 'zahialga' && d.dot && !d.logo} onClick={() => { if (confirm('Нэр, лого анхны (zahialga•) руу буцах уу?')) void run('reset', () => api<D>('/api/settings/brand', { method: 'POST', json: { kind: 'reset' } }), 'Анхны руу буцлаа'); }}>Анхны руу буцаах</Button>
        </div>
        <p className="text-[12.5px] text-subtle">Лого: JPG, PNG, WEBP (10MB хүртэл). Дөрвөлжин хэлбэрт голоос нь автоматаар тасална — хамгийн сайн нь дөрвөлжин зураг.</p>
      </>) : null}
    </section>
  );
}
