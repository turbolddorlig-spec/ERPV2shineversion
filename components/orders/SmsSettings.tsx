'use client';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';
import { ubDateTime } from '@/lib/format';

export interface SmsData {
  enabled: boolean; testMode: boolean; testPhone: string; template: string; bank: string; account: string; holder: string; url: string; body: string;
  keySet: boolean; keyHint: string | null; tokenSet: boolean; tokenHint: string | null;
  defaults: { url: string; body: string; template: string }; vars: string[];
  preview: { text: string; length: number; limit: number; cut: boolean };
  counts: Record<string, number>;
  recent: { id: number; orderNumber: string | null; phone: string; text: string; status: string; test: boolean; attempts: number; lastError: string | null; sentAt: string | null; createdAt: string }[];
}
const LABEL: Record<string, string> = { PENDING: 'Дараалалд', SENT: 'Илгээсэн', FAILED: 'Алдаатай', SKIPPED: 'Алгассан' };
const VAR_HINT: Record<string, string> = { '{дугаар}': 'захиалгын дугаар', '{бараа}': 'бараа, тоо', '{дүн}': 'нийт дүн', '{утас}': 'үйлчлүүлэгчийн утас', '{банк}': 'банк', '{данс}': 'данс', '{эзэмшигч}': 'эзэмшигч' };
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const area = 'w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft';

/** #166 «Төлбөр хүлээж буй» захиалгын SMS — зөвхөн Супер админ */
export function SmsSettings({ s, onSaved }: { s: SmsData; onSaved: () => Promise<unknown> | void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(() => init(s));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [prev, setPrev] = useState(s.preview);
  const [adv, setAdv] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setF(init(s)); setPrev(s.preview); }, [s]);
  useEffect(() => { if (typeof window !== 'undefined' && window.location.hash === '#sms') setOpen(true); }, []);
  // Урьдчилсан харагдац — бичих зогсохоос 400мс-ийн дараа
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api<SmsData['preview']>('/api/settings/orders', { method: 'POST', json: { kind: 'sms-preview', template: f.template, bank: f.bank, account: f.account, holder: f.holder } }).then(setPrev).catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [open, f.template, f.bank, f.account, f.holder]);

  async function call(key: string, json: Record<string, unknown>, done: string) {
    setBusy(key); setErr(null); setOk(null);
    try {
      const r = await api<{ ok?: boolean; info?: string }>('/api/settings/orders', { method: 'POST', json });
      if (key === 'test') { if (r.ok) setOk(`Туршилтын SMS явлаа ✓ ${r.info ?? ''}`); else setErr(`SMS явсангүй: ${r.info ?? ''}`); }
      else setOk(done);
      await onSaved();
    } catch (e) { setErr(msg(e)); } finally { setBusy(null); }
  }
  const insertVar = (v: string) => {
    const el = ta.current; const t = f.template;
    const a = el?.selectionStart ?? t.length; const b = el?.selectionEnd ?? t.length;
    setF({ ...f, template: t.slice(0, a) + v + t.slice(b) });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + v.length, a + v.length); });
  };
  const save = (extra: Record<string, unknown> = {}) => call('save', {
    kind: 'sms', template: f.template, bank: f.bank, account: f.account, holder: f.holder, testPhone: f.testPhone, testMode: f.testMode,
    url: f.url, body: f.body, ...(f.key ? { key: f.key } : {}), ...(f.token ? { token: f.token } : {}), ...extra,
  }, 'SMS тохиргоо хадгаллаа');

  return (
    <section id="sms" className="flex min-w-0 flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card lg:col-span-2">
      <button type="button" data-sms-toggle aria-expanded={open} onClick={() => setOpen(!open)} className="-m-1 flex flex-wrap items-center gap-2 rounded-xl p-1 text-left hover:bg-surface2">
        <span aria-hidden className="w-4 text-[13px] text-muted">{open ? '▾' : '▸'}</span>
        <h2 className="text-[16px] font-extrabold">SMS — «Төлбөр хүлээж буй» захиалга</h2>
        {s.enabled ? (s.testMode ? <Badge tone="warn">Туршилтын горим</Badge> : <Badge tone="ok">Асаалттай</Badge>) : <Badge tone="neutral">Унтраалттай</Badge>}
        {s.counts.FAILED ? <Badge tone="bad">Алдаатай {s.counts.FAILED}</Badge> : null}
        <span className="ml-auto text-[13px] font-semibold text-muted">{open ? 'Хаах' : 'Нээх'}</span>
      </button>
      {open ? (<>
        <p className="text-[13px] text-subtle">Захиалга «Төлбөр хүлээж буй» болж үүсэхэд үйлчлүүлэгчийн утас руу нэг л удаа SMS явна. Дугаар, бараа, дүн, утсыг систем өөрөө бөглөнө — та зөвхөн үгээ бичнэ. Захиалгын төлөв, мөнгөнд нөлөөлөхгүй. Зөвхөн Супер админ засна; өөрчлөлт бүр түүхэнд бичигдэнэ.</p>
        {err ? <Notice>{err}</Notice> : null}
        {ok ? <Notice tone="ok">{ok}</Notice> : null}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="sms-template" className="text-[13px] font-semibold text-muted">Мессежийн текст</label>
          <textarea id="sms-template" ref={ta} rows={3} value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })} className={area} />
          <div className="flex flex-wrap gap-1.5">
            {s.vars.map((v) => (
              <button key={v} type="button" onClick={() => insertVar(v)} title={VAR_HINT[v]} className="rounded-full border border-line bg-surface2 px-2.5 py-1 text-[12.5px] font-semibold hover:border-accent">
                + {v} <span className="font-normal text-muted">{VAR_HINT[v]}</span>
              </button>
            ))}
          </div>
        </div>
        <div data-sms-preview className="rounded-xl border border-dashed border-line bg-surface2 p-3 text-[13.5px]">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-[12px] font-semibold text-muted">
            Жишээ захиалгаар:
            <span className={clsx(prev.length > prev.limit - 10 ? 'text-warn' : 'text-ok-ink')}>{prev.length}/{prev.limit} тэмдэгт · 1 SMS</span>
            {prev.limit === 70 ? <Badge tone="warn">Кирилл үсэг байна — 70 тэмдэгт</Badge> : null}
            {prev.cut ? <Badge tone="warn">Урт тул барааг богиносгосон</Badge> : null}
          </div>
          <p className="[overflow-wrap:anywhere] font-mono text-[13px]">{prev.text}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="sms-bank" label="Банк" placeholder="Khan bank" value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} />
          <Field id="sms-account" label="Дансны дугаар" inputMode="numeric" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} />
          <Field id="sms-holder" label="Данс эзэмшигч" value={f.holder} onChange={(e) => setF({ ...f, holder: e.target.value })} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="sms-key" label="API түлхүүр (apiKey)" type="password" autoComplete="off" value={f.key} placeholder={s.keyHint ? `Хадгалсан ${s.keyHint}` : ''} onChange={(e) => setF({ ...f, key: e.target.value })} hint="Солих үед л бичнэ" />
          <Field id="sms-token" label="Токен (apiToken)" type="password" autoComplete="off" value={f.token} placeholder={s.tokenHint ? `Хадгалсан ${s.tokenHint}` : ''} onChange={(e) => setF({ ...f, token: e.target.value })} hint="Солих үед л бичнэ" />
          <Field id="sms-testphone" label="Туршилтын утас (таных)" inputMode="numeric" maxLength={8} value={f.testPhone} onChange={(e) => setF({ ...f, testPhone: e.target.value.replace(/\D/g, '').slice(0, 8) })} />
        </div>
        <label className="flex items-center gap-2 text-[14px] font-semibold">
          <input type="checkbox" checked={f.testMode} onChange={(e) => setF({ ...f, testMode: e.target.checked })} className="h-5 w-5 accent-[var(--accent)]" />
          Туршилтын горим — бүх SMS зөвхөн туршилтын утас руу явна
        </label>

        <button type="button" onClick={() => setAdv(!adv)} className="self-start text-[13px] font-semibold text-muted underline">{adv ? '▾' : '▸'} SMS үйлчилгээ (өөр компани руу шилжих бол)</button>
        {adv ? (
          <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
            <Field id="sms-url" label="Илгээх хаяг (https)" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="sms-body" className="text-[13px] font-semibold text-muted">Илгээх өгөгдөл (JSON) — {'{key} {token} {phone} {message}'}</label>
              <textarea id="sms-body" rows={3} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} className={clsx(area, 'font-mono text-[12.5px]')} />
            </div>
            <Button size="sm" className="self-start" onClick={() => setF({ ...f, url: s.defaults.url, body: s.defaults.body })}>SendSMS.mn-ийн анхны утга</Button>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy === 'save'} onClick={() => save()}>Хадгалах</Button>
          <Button loading={busy === 'test'} disabled={!s.keySet || !s.testPhone} onClick={() => call('test', { kind: 'sms-test' }, '')} title={!s.keySet || !s.testPhone ? 'Эхлээд түлхүүр, туршилтын утсаа хадгална уу' : ''}>Туршиж илгээх (таны утас руу)</Button>
          {s.enabled
            ? <Button variant="danger" loading={busy === 'off'} onClick={() => call('off', { kind: 'sms', enabled: false }, 'SMS унтраалаа')}>Унтраах</Button>
            : <Button variant="dark" loading={busy === 'on'} onClick={() => call('on', { kind: 'sms', enabled: true }, 'SMS асаалаа')}>Асаах</Button>}
          {s.counts.FAILED ? <Button loading={busy === 'retry'} onClick={() => call('retry', { kind: 'sms-retry' }, 'Алдаатайг дахин дараалалд орууллаа')}>Алдаатай {s.counts.FAILED}-г дахин илгээх</Button> : null}
        </div>
        <div className="flex flex-wrap gap-2 text-[13px]">{Object.entries(LABEL).map(([k, l]) => <Badge key={k} tone={k === 'SENT' ? 'ok' : k === 'FAILED' ? 'bad' : 'neutral'}>{l}: {s.counts[k] ?? 0}</Badge>)}</div>
        {s.recent.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-[13px]">
              <thead className="text-left text-muted"><tr><th className="py-1.5">Захиалга</th><th>Утас</th><th>Төлөв</th><th>Огноо</th><th>Текст / алдаа</th></tr></thead>
              <tbody className="divide-y divide-line">
                {s.recent.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="py-1.5 font-bold">{r.orderNumber ? `№${r.orderNumber}` : '—'}</td>
                    <td>{r.phone}{r.test ? <span className="ml-1 text-[11px] text-warn">тест</span> : null}</td>
                    <td>{LABEL[r.status] ?? r.status}{r.attempts > 1 ? ` (${r.attempts})` : ''}</td>
                    <td className="whitespace-nowrap">{ubDateTime(r.sentAt ?? r.createdAt)}</td>
                    <td className="max-w-[420px] [overflow-wrap:anywhere]">{r.lastError ? <span className="text-bad-ink">{r.lastError}</span> : <span className="text-muted">{r.text}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </>) : null}
    </section>
  );
}

function init(s: SmsData) {
  return { template: s.template, bank: s.bank, account: s.account, holder: s.holder, testPhone: s.testPhone, testMode: s.testMode, url: s.url, body: s.body, key: '', token: '' };
}
