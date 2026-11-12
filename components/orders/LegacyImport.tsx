'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Notice';
import { Badge } from '@/components/ui/Badge';
import { api, ApiError } from '@/components/ui/api';

/**
 * Тохиргоо → Туршилтын оруулалт (#138, зөвхөн Супер админ): хуучин ERP-ийн нэг жолоочийн захиалгын жагсаалтыг хуулж наагаад
 * «Шалгах» → «Батлах». Бараа, жолооч, захиалга, падаан, Хүргэсэн / Цуцалсан / Маргааш жинхэнэ урсгалаар үүснэ.
 */
type Row = {
  number: string; opp: string; phone: string; address: string; note: string | null; amount: number; statusText: string; paymentText: string;
  lines: { code: string; name: string; qty: number; price: number }[]; action: 'DELIVER' | 'CANCEL' | 'POSTPONE' | null;
  tomorrow: boolean; existing: { number: number; status: string } | null; errors: string[]; warnings: string[];
};
type Preview = {
  ok: boolean; general: string[]; rows: Row[]; today: string; warehouse: string | null;
  summary: { total: number; new: number; existing: number; deliver: number; deliverSum: number; cash: number; bank: number; cancel: number; cancelSum: number; postpone: number; postponeSum: number; salary: number; rate: number; rateLabel: string };
  driver: { name: string; phone: string; isNew: boolean } | null;
  products: { code: string; name: string; isNew: boolean; listPrice: number; need: number; have: number; receipt: number; errors: string[] }[];
  opps: { name: string; count: number; suggestId: string }[]; operators: { id: string; name: string }[];
};
type Done = {
  steps: string[]; tempPassword: string | null; driver: { name: string; phone: string };
  day: { delivered: number; deliveredAmount: number; cash: number; bank: number; cancelled: number; postponed: number; rate: number; salary: number; toReceive: number };
};
const mnt = (n: number) => `${n.toLocaleString('mn-MN')}₮`;
const ACTION: Record<string, { label: string; tone: 'ok' | 'bad' | 'warn' }> = {
  DELIVER: { label: 'Хүргэсэн', tone: 'ok' }, CANCEL: { label: 'Цуцалсан', tone: 'bad' }, POSTPONE: { label: 'Маргааш', tone: 'warn' },
};

export function LegacyImport() {
  const [f, setF] = useState({ driverName: '', driverPhone: '', text: '' });
  const [pv, setPv] = useState<Preview | null>(null);
  const [oppMap, setOppMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'check' | 'commit' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [errSteps, setErrSteps] = useState<string[]>([]);
  const [done, setDone] = useState<Done | null>(null);
  const [onlyBad, setOnlyBad] = useState(false);

  const check = async () => {
    setBusy('check'); setErr(null); setErrSteps([]); setDone(null);
    try {
      const r = await api<Preview>('/api/settings/legacy-import', { method: 'POST', json: { action: 'preview', ...f } });
      setPv(r);
      setOppMap(Object.fromEntries(r.opps.map((o) => [o.name, oppMap[o.name] ?? o.suggestId])));
      setOnlyBad(!r.ok);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Алдаа гарлаа'); } finally { setBusy(null); }
  };
  const commit = async () => {
    if (!pv?.ok) return;
    if (!window.confirm(`${pv.driver?.name}-д ${pv.summary.new} шинэ захиалга оруулж, хүргэсэн ${pv.summary.deliver} / цуцалсан ${pv.summary.cancel} / маргааш ${pv.summary.postpone} болгох уу? Энэ нь бодит үлдэгдэл, тооцоонд орно.`)) return;
    setBusy('commit'); setErr(null); setErrSteps([]);
    try {
      const res = await fetch('/api/settings/legacy-import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'commit', ...f, oppMap }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data.error ?? 'Алдаа гарлаа'); setErrSteps(data.steps ?? []); return; }
      setDone(data as Done); setPv(null);
    } catch { setErr('Холболт тасарлаа — «Шалгах» дарж хаана хүрснийг харна уу (давтан батлахад давхардахгүй)'); } finally { setBusy(null); }
  };
  const reset = () => { setF({ driverName: '', driverPhone: '', text: '' }); setPv(null); setDone(null); setErr(null); setErrSteps([]); };

  const rows = pv ? (onlyBad ? pv.rows.filter((r) => r.errors.length || r.warnings.length) : pv.rows) : [];
  const badN = pv ? pv.rows.filter((r) => r.errors.length).length : 0;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {done ? (
        <div className="flex flex-col gap-3">
          <Notice tone="ok">✓ {done.driver.name} ({done.driver.phone}) — оруулалт дууслаа</Notice>
          {done.tempPassword ? <Notice tone="warn">Шинэ жолоочийн түр нууц үг: <b className="select-all font-mono">{done.tempPassword}</b> — жолоочид өгнө (анх нэвтрэхэд солино). Дахин харагдахгүй.</Notice> : null}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Хүргэсэн" value={`${done.day.delivered} · ${mnt(done.day.deliveredAmount)}`} />
            <Stat label="Цуцалсан / Маргааш" value={`${done.day.cancelled} / ${done.day.postponed}`} />
            <Stat label={`Цалин (${mnt(done.day.rate)} × ${done.day.delivered})`} value={mnt(done.day.salary)} />
            <Stat label="Жолоочоос авах" value={mnt(done.day.toReceive)} strong />
          </div>
          <ul className="list-disc pl-5 text-[13px] text-muted">{done.steps.map((s, i) => <li key={i} className="[overflow-wrap:anywhere]">{s}</li>)}</ul>
          <div className="flex flex-wrap gap-2">
            <a href="/accounting" className="inline-flex h-10 items-center rounded-[11px] bg-ink px-4 text-[14px] font-bold text-on-ink">Нягтлан хуудас руу</a>
            <Button onClick={reset}>Дараагийн жолооч</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="li-name" label="Жолоочийн нэр" placeholder="Жишээ: Батаа" value={f.driverName} onChange={(e) => { setF({ ...f, driverName: e.target.value }); setPv(null); }} />
            <Field id="li-phone" label="Жолоочийн утас" inputMode="numeric" placeholder="8 оронтой" value={f.driverPhone} onChange={(e) => { setF({ ...f, driverPhone: e.target.value }); setPv(null); }} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="li-text" className="text-[13px] font-semibold text-muted">Хуучин ERP-ийн жагсаалт (бүтнээр нь хуулж наана)</label>
            <textarea id="li-text" rows={8} value={f.text} onChange={(e) => { setF({ ...f, text: e.target.value }); setPv(null); }}
              placeholder={'24 захиалга\nДугаар\tҮүссэн огноо\tOPP\tУтас ...\n00167223\n11/10/2026\tБолоржин-опп\t99080958 ...'}
              className="min-h-[160px] w-full min-w-0 rounded-xl border border-line bg-surface px-3 py-2 font-mono text-[12.5px]" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="dark" loading={busy === 'check'} disabled={!f.text.trim() || busy !== null} onClick={check}>Шалгах</Button>
            {pv ? <Button variant="primary" loading={busy === 'commit'} disabled={!pv.ok || busy !== null} onClick={commit}>Батлах ({pv.summary.new} захиалга)</Button> : null}
          </div>
        </>
      )}

      {err ? <Notice>{err}</Notice> : null}
      {errSteps.length ? <Notice tone="warn">Алдаанаас өмнө хийгдсэн: {errSteps.join(' · ')}. Засаад дахин «Шалгах» → «Батлах» дарвал үлдсэнээс нь үргэлжилнэ.</Notice> : null}

      {pv ? (
        <div className="flex min-w-0 flex-col gap-3">
          {pv.general.map((g, i) => <Notice key={i}>{g}</Notice>)}
          {pv.ok ? <Notice tone="ok">✓ Алдаагүй — «Батлах» дарж болно</Notice> : badN ? <Notice>{badN} захиалга алдаатай — доор улаанаар</Notice> : null}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Нийт" value={`${pv.summary.total}${pv.summary.existing ? ` (өмнө орсон ${pv.summary.existing})` : ''}`} />
            <Stat label="Хүргэсэн" value={`${pv.summary.deliver} · ${mnt(pv.summary.deliverSum)}`} />
            <Stat label="Цуцалсан / Маргааш" value={`${pv.summary.cancel} / ${pv.summary.postpone}`} />
            <Stat label={`Цалин (${pv.summary.rateLabel}: ${mnt(pv.summary.rate)} × ${pv.summary.deliver})`} value={mnt(pv.summary.salary)} />
          </div>
          <p className="text-[13px] text-subtle [overflow-wrap:anywhere]">
            Жолооч: <b>{pv.driver?.name ?? '—'}</b> {pv.driver?.isNew ? <Badge tone="info">шинээр үүснэ</Badge> : pv.driver ? <Badge>бүртгэлтэй</Badge> : null} · Огноо: {pv.today} · Агуулах: {pv.warehouse ?? '—'} ·
            Бэлнээр авах: {mnt(pv.summary.cash - pv.summary.salary)} (бэлэн {mnt(pv.summary.cash)} − цалин){pv.summary.bank ? ` · данс ${mnt(pv.summary.bank)}` : ''}
          </p>

          {pv.opps.length ? (
            <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
              <b className="text-[14px]">OPP → V2 оператор</b>
              <p className="text-[12.5px] text-subtle">Захиалга хэний нэр дээр үүсэх вэ. Сонгоогүй бол таны нэр дээр үүсэж, OPP нэр нь тэмдэглэлд бичигдэнэ.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {pv.opps.map((o) => (
                  <label key={o.name} className="flex min-w-0 items-center gap-2 text-[13px]">
                    <span className="min-w-0 flex-1 truncate" title={o.name}>{o.name} <span className="text-subtle">({o.count})</span></span>
                    <select value={oppMap[o.name] ?? ''} onChange={(e) => setOppMap({ ...oppMap, [o.name]: e.target.value })} className="h-10 min-w-0 max-w-[55%] rounded-lg border border-line bg-surface px-2">
                      <option value="">Би (тэмдэглэлд)</option>
                      {pv.operators.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          <details className="rounded-xl border border-line p-3">
            <summary className="cursor-pointer text-[14px] font-bold">Бараа ({pv.products.length}) · шинэ {pv.products.filter((p) => p.isNew).length} · «Орлого» {pv.products.reduce((a, p) => a + p.receipt, 0)} ш</summary>
            <ul className="mt-2 flex flex-col gap-1 text-[13px]">
              {pv.products.map((p) => (
                <li key={p.code} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-mono text-subtle">[{p.code}]</span>
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{p.name}</span>
                  {p.isNew ? <Badge tone="info">шинэ</Badge> : null}
                  <span>{mnt(p.listPrice)} · хэрэгтэй {p.need}{p.receipt ? ` · орлого +${p.receipt}` : ''}</span>
                  {p.errors.map((e, i) => <span key={i} className="w-full text-bad-ink">{e}</span>)}
                </li>
              ))}
            </ul>
          </details>

          <div className="flex items-center justify-between gap-2">
            <b className="text-[14px]">Захиалгууд</b>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} /> Зөвхөн алдаа / анхааруулгатай</label>
          </div>
          <ul className="flex flex-col gap-2">
            {rows.map((r) => (
              <li key={r.number} className={`flex min-w-0 flex-col gap-1 rounded-xl border p-3 text-[13px] ${r.errors.length ? 'border-bad-ink/40 bg-bad-soft/40' : 'border-line'}`}>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <b className="font-mono">{r.number}</b>
                  {r.action ? <Badge tone={ACTION[r.action]!.tone}>{ACTION[r.action]!.label}</Badge> : null}
                  {r.existing ? <Badge>өмнө орсон · №{r.existing.number}</Badge> : null}
                  <span>{r.phone}</span>
                  <span className="text-subtle">{r.opp}</span>
                  <b className="ml-auto">{mnt(r.amount)}</b>
                </div>
                <div className="min-w-0 text-muted [overflow-wrap:anywhere]">{r.address}{r.note ? <span className="text-subtle"> · санамж: {r.note}</span> : null}</div>
                <div className="min-w-0 [overflow-wrap:anywhere]">{r.lines.map((l) => `${l.name} ${l.qty}ш × ${mnt(l.price)}`).join('; ')}</div>
                {r.errors.map((e, i) => <div key={i} className="font-semibold text-bad-ink [overflow-wrap:anywhere]">✗ {e}</div>)}
                {r.warnings.map((w, i) => <div key={i} className="text-warn [overflow-wrap:anywhere]">! {w}</div>)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-line bg-surface2 px-3 py-2">
      <span className="text-[12px] text-subtle [overflow-wrap:anywhere]">{label}</span>
      <span className={`[overflow-wrap:anywhere] ${strong ? 'text-[16px] font-extrabold' : 'text-[14px] font-bold'}`}>{value}</span>
    </div>
  );
}
