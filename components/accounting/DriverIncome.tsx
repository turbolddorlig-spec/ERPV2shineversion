'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Badge } from '@/components/ui/Badge';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';
import { DayPanels, Row, type Detail } from './AccountingClient';
import { LedgerList, type Ledger } from './AccountingDialogs';

/**
 * Жолоочийн «Орлого» (хуучин шиг): өдөр сонгох, гүйцэтгэлийн тооцоо, Бэлэн/Данс, «Авах дүн», «Тооцоо нийлэх» (Бэлэн + Данс + Өр = Авах дүн),
 * «Тооцоо буцаах», «Нэмэлт барааны тооцоо», «Урьдчилгаа шилжүүлэх». Нягтлантай яг ижил тоо (нэг функц).
 */
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const ubToday = (add = 0) => new Date(Date.now() + 8 * 3600_000 + add * 86_400_000).toISOString().slice(0, 10);
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);
type Income = Detail & { date: string; today: string; companyDebt: { amount: number; count: number } };
const digits = (s: string) => s.replace(/[^\d]/g, '');

export function IncomeTab() {
  const [date, setDate] = useState(ubToday());
  const [d, setD] = useState<Income | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [cash, setCash] = useState('');
  const [bank, setBank] = useState('');
  const [debt, setDebt] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await api<Income>(`/api/driver/income?date=${date}`);
      setD(r); setErr(null);
      const s = r.day.settlement;
      if (s && s.status !== 'DRAFT') { setCash(String(s.cashAmount)); setBank(String(s.bankAmount)); setDebt(String(s.debtAmount)); }
      else { setBank(String(r.day.bank)); setDebt(''); setCash(String(Math.max(0, r.day.toReceive - r.day.bank))); }
    } catch (e) { setErr(msg(e)); }
  }, [date]);
  useEffect(() => { void load(); }, [load]);
  const r = d?.day;
  const s = r?.settlement;
  const num = (v: string) => (v === '' || v === '-' ? 0 : Number(v));
  const sum = num(cash) + num(bank) + num(debt);
  const unfinished = r ? r.out + r.notReceived : 0;
  const submit = async () => {
    setBusy(true); setErr(null); setOk(null);
    try { await api('/api/driver/income', { method: 'POST', json: { action: 'submit', date, cash: num(cash), bank: num(bank), debt: num(debt) } }); setOk('Тооцоо илгээгдлээ — нягтлан баталгаажуулахыг хүлээнэ үү'); await load(); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const withdraw = async () => {
    setBusy(true); setErr(null); setOk(null);
    try { await api('/api/driver/income', { method: 'POST', json: { action: 'withdraw', date } }); await load(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const editable = !s || s.status === 'DRAFT';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {[[-2, null], [-1, 'Өчигдөр'], [0, 'Өнөөдөр']].map(([a, l]) => { const x = ubToday(Number(a)); return <button key={String(a)} onClick={() => setDate(x)} className={clsx('h-10 rounded-full border px-3.5 text-[13px] font-bold', date === x ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>{l ?? x.slice(5).replace('-', '.')}</button>; })}
        <input type="date" max={ubToday()} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-10 rounded-[10px] border border-line bg-surface px-2 text-[14px]" aria-label="Огноо" />
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
      {d && r ? (
        <>
          {d.companyDebt.amount ? <Notice tone="warn">Компанид өгөх өр: <b>{money(d.companyDebt.amount)}</b> ({d.companyDebt.count}) — «Төлбөр тооцоо» табаас харна уу</Notice> : null}
          {unfinished ? <Notice tone="warn"><b>Анхаар!</b> Дуусаагүй захиалга {unfinished} — хүргэсэн / цуцалсан / маргааш болгосны дараа тооцоо нийлнэ.</Notice> : null}
          <DayPanels d={d} />
          <div className="rounded-[16px] border-2 border-accent/40 bg-surface p-3.5">
            <div className="flex items-baseline justify-between gap-2"><span className="text-[15px] font-extrabold">Авах дүн:</span><span className="text-[22px] font-extrabold">{money(r.toReceive)}</span></div>
            {s?.status === 'COMPLETED' ? (
              <div className="mt-2"><Badge tone="ok">✓ Нягтлан баталгаажуулсан</Badge>
                <div className="mt-1 text-[13px] text-muted">Бэлэн {money(s.cashAmount)} · Данс {money(s.bankAmount)} · Өр {money(s.debtAmount)} · {s.approvedByName} {ubDateTime(s.approvedAt)}</div></div>
            ) : s?.status === 'PENDING' ? (
              <div className="mt-2"><Badge tone="warn">Нягтлан баталгаажуулах хүлээж байна</Badge>
                <div className="mt-1 text-[13px] text-muted">Бэлэн {money(s.cashAmount)} · Данс {money(s.bankAmount)} · Өр {money(s.debtAmount)}</div>
                <Button className="mt-2" loading={busy} onClick={() => void withdraw()}>Тооцоо буцаах</Button></div>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                <div className="text-[13px] font-bold">Тооцоо нийлэх</div>
                <div className="grid grid-cols-3 gap-2">
                  {([['Бэлэн мөнгө', cash, setCash, r.toReceive < 0], ['Данс', bank, setBank, false], ['Өр', debt, setDebt, false]] as const).map(([l, v, set, neg]) => (
                    <label key={l} className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-muted">{l}
                      <input inputMode="numeric" value={v} disabled={!editable} onChange={(e) => set(neg ? e.target.value.replace(/[^\d-]/g, '') : digits(e.target.value))} className="h-12 min-w-0 rounded-xl border border-line bg-surface px-2 text-right text-[16px] font-bold text-ink" /></label>
                  ))}
                </div>
                <Row l="Тооцоолсон нийт" v={money(sum)} tone={sum === r.toReceive ? 'ok' : 'bad'} />
                {sum !== r.toReceive ? <p className="text-[12.5px] text-bad-ink">Бэлэн + Данс + Өр = {money(r.toReceive)} байх ёстой (зөрүү {money(r.toReceive - sum)})</p> : null}
                {r.toReceive < 0 ? <p className="text-[12.5px] text-muted">Авах дүн хасах — компани танд {money(-r.toReceive)} өгнө (Бэлэн-д хасахаар бичнэ).</p> : null}
                <Button variant="primary" size="lg" loading={busy} disabled={sum !== r.toReceive || !!unfinished || (!r.handover && !r.total)} onClick={() => void submit()}>Тооцоо нийлэх</Button>
              </div>
            )}
          </div>
          <PaymentSection kind="EXTRA" title="Нэмэлт барааны тооцоо" date={date} list={d.payments.filter((p) => p.kind === 'EXTRA')} onChanged={load} hint={r.extraSale.amount ? `Өнөөдөр нэмэлт бараа зарсан: ${money(r.extraSale.amount)}` : undefined} />
          <PaymentSection kind="ADVANCE" title="Урьдчилгаа шилжүүлэх" date={date} list={d.payments.filter((p) => p.kind === 'ADVANCE')} onChanged={load} />
        </>
      ) : null}
    </div>
  );
}

function PaymentSection({ kind, title, date, list, onChanged, hint }: { kind: string; title: string; date: string; list: Detail['payments']; onChanged: () => void; hint?: string }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [key, setKey] = useState(newKey());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    setBusy(true); setErr(null);
    try { await api('/api/driver/payments', { method: 'POST', json: { kind, date, amount: Number(amount), note, idemKey: key } }); setAmount(''); setNote(''); setKey(newKey()); onChanged(); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const del = async (id: number) => { try { await api(`/api/driver/payments/${id}`, { method: 'DELETE' }); onChanged(); } catch (e) { setErr(msg(e)); } };
  return (
    <div className="rounded-[16px] border border-line bg-surface p-3.5">
      <div className="text-[14px] font-extrabold">{title}</div>
      {hint ? <p className="text-[12.5px] text-muted">{hint}</p> : null}
      <p className="text-[12px] text-subtle">Нягтлан «Зөвшөөрөх» хүртэл хүлээгдэнэ. «Авах дүн»-д орохгүй.</p>
      <div className="mt-2 grid grid-cols-[120px_1fr] gap-2">
        <input inputMode="numeric" value={amount} onChange={(e) => setAmount(digits(e.target.value))} placeholder="Дүн (₮)" className="h-11 min-w-0 rounded-xl border border-line bg-surface px-2 text-right font-bold" aria-label={`${title} дүн`} />
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Тайлбар (заавал биш)" className="h-11 min-w-0 rounded-xl border border-line bg-surface px-3" aria-label={`${title} тайлбар`} />
      </div>
      <Button className="mt-2 w-full" variant="dark" loading={busy} disabled={!amount} onClick={() => void add()}>Илгээх</Button>
      {err ? <div className="mt-2"><Notice>{err}</Notice></div> : null}
      {list.length ? (
        <ul className="mt-2 divide-y divide-line text-[13px]">
          {list.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 py-1.5">
              <span className="min-w-0 [overflow-wrap:anywhere]"><b>{money(p.amount)}</b>{p.note ? ` · ${p.note}` : ''}<span className="block text-[11.5px] text-subtle">{ubDateTime(p.createdAt)}</span></span>
              {p.approved ? <Badge tone="ok">Зөвшөөрсөн</Badge> : <span className="flex shrink-0 items-center gap-1.5"><Badge tone="warn">Хүлээгдэж байна</Badge><button onClick={() => void del(p.id)} className="text-[12px] font-semibold text-bad-ink">Устгах</button></span>}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Жолоочийн «Төлбөр тооцоо» — компанид өгөх өр (зөвхөн харах; хувийн «Өрийн дэвтэр»-ээс тусдаа) */
export function CompanyDebtTab() {
  const [l, setL] = useState<Ledger | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<Ledger>('/api/driver/company-debts').then(setL).catch((e) => setErr(msg(e))); }, []);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted">Компанид өгөх өр (нягтлан хөтөлнө). Буцаагаагүй бараа өдрийн эцэст автоматаар өр болж, агуулахад буцааж өгөхөд автоматаар хаагдана. Үйлчлүүлэгчийн өр — «Захиалга → Өрийн дэвтэр».</p>
      {err ? <Notice>{err}</Notice> : null}
      {l ? <LedgerList l={l} /> : null}
    </div>
  );
}
