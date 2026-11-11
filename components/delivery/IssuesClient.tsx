'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';
import { OperatorNote } from '@/components/orders/OrdersClient';
import { money, ubDateTime } from '@/lib/format';

/** «Опп-руу явуулах» асуудлууд (хуучин ERP-ийн ОПП ахлах): «Зассан» эсвэл «Цуцлах» (хэний алдаа) */
interface IOrder {
  id: number; number: string; phone: string; extraPhone: string | null; fullAddress: string; note: string | null; total: number; driverName: string | null; status: string; statusLabel: string;
  operatorName: string; issueLabel: string | null; issueNote: string | null; issueAt: string | null; issueStatus: string | null; faultLabel: string | null;
  issueResolveNote: string | null; issueResolvedByName: string | null; issueResolvedAt: string | null; lines: { id: number; name: string; label: string; qty: number }[];
}
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const FAULTS = [['OPERATOR', 'Опп-н алдаа'], ['DRIVER', 'Жолоочийн алдаа'], ['MARKETING', 'Маркетингийн алдаа'], ['WAREHOUSE', 'Агуулахын алдаа']] as const;

export function IssuesClient() {
  const [status, setStatus] = useState<'pending' | 'resolved'>('pending');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: IOrder[]; hasMore: boolean; canResolve: boolean; pending: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dlg, setDlg] = useState<{ o: IOrder; action: 'fix' | 'cancel' } | null>(null);
  const load = useCallback(async () => { try { setData(await api(`/api/issues?status=${status}&page=${page}`)); setErr(null); } catch (e) { setErr(msg(e)); } }, [status, page]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="flex flex-col gap-4">
      <div><h1 className="text-[24px] font-extrabold tracking-tight">Асуудал</h1><p className="text-[13.5px] text-muted">Жолоочийн «Опп-руу явуулах» — шийдэгдэх хүртэл жолооч тухайн захиалгыг хүргэхгүй</p></div>
      <div className="flex gap-1.5">
        {([['pending', `Шийдээгүй${data ? ` (${data.pending})` : ''}`], ['resolved', 'Шийдсэн']] as const).map(([k, l]) => (
          <button key={k} onClick={() => { setStatus(k); setPage(1); }} className={clsx('h-10 rounded-full border px-4 text-[13.5px] font-bold', status === k ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-muted')}>{l}</button>
        ))}
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {data && !data.items.length ? <p className="rounded-[14px] border border-dashed border-line px-4 py-10 text-center text-muted">{status === 'pending' ? 'Шийдээгүй асуудал алга' : 'Алга'}</p> : null}
      <ul className="grid gap-3 md:grid-cols-2">
        {data?.items.map((o) => (
          <li key={o.id} className="flex min-w-0 flex-col gap-2 rounded-[16px] border border-line bg-surface p-3.5 shadow-card">
            <div className="flex flex-wrap items-center gap-2"><b className="text-[16px]">№{o.number}</b><span className="rounded-md bg-warn-soft px-2 py-0.5 text-[12px] font-extrabold text-warn">{o.issueLabel}</span><span className="text-[12.5px] text-subtle">{o.issueAt ? ubDateTime(o.issueAt) : ''}</span><b className="ml-auto">{money(o.total)}</b></div>
            <p className="text-[13.5px] [overflow-wrap:anywhere]">Жолооч: <b>{o.driverName ?? '—'}</b> · Оператор: {o.operatorName} · {o.statusLabel}</p>
            {o.issueNote ? <p className="rounded-[10px] bg-surface2 px-3 py-2 text-[13.5px] [overflow-wrap:anywhere]">💬 {o.issueNote}</p> : null}
            <p className="text-[13.5px] [overflow-wrap:anywhere]"><b>{o.phone}</b>{o.extraPhone ? ` · ${o.extraPhone}` : ''} · {o.fullAddress}</p>
            {o.note ? <OperatorNote text={o.note} className="!block" /> : null}
            <p className="text-[12.5px] text-muted [overflow-wrap:anywhere]">{o.lines.map((l) => `${l.name}${l.label ? ` · ${l.label}` : ''} ${l.qty}ш`).join(', ')}</p>
            {o.issueStatus !== 'PENDING' ? (
              <p className={clsx('rounded-[10px] px-3 py-2 text-[13px] font-semibold [overflow-wrap:anywhere]', o.issueStatus === 'FIXED' ? 'bg-info-soft text-info' : 'bg-bad-soft text-bad-ink')}>
                {o.issueStatus === 'FIXED' ? 'Зассан' : `Цуцалсан · ${o.faultLabel}`}: {o.issueResolveNote} — {o.issueResolvedByName}, {o.issueResolvedAt ? ubDateTime(o.issueResolvedAt) : ''}
              </p>
            ) : data.canResolve ? (
              <div className="grid grid-cols-2 gap-2"><Button variant="primary" onClick={() => setDlg({ o, action: 'fix' })}>Зассан</Button><Button variant="danger" onClick={() => setDlg({ o, action: 'cancel' })}>Цуцлах</Button></div>
            ) : <p className="text-[12.5px] text-subtle">Ахлах оператор шийднэ</p>}
          </li>
        ))}
      </ul>
      {data && (page > 1 || data.hasMore) ? (
        <div className="flex items-center justify-center gap-3"><Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Өмнөх</Button><span className="text-[13px] text-muted">{page}-р хуудас</span><Button size="sm" variant="ghost" disabled={!data.hasMore} onClick={() => setPage((p) => p + 1)}>Дараах</Button></div>
      ) : null}
      {dlg ? <ResolveModal o={dlg.o} action={dlg.action} onClose={() => setDlg(null)} onDone={async () => { setDlg(null); await load(); }} /> : null}
    </div>
  );
}

function ResolveModal({ o, action, onClose, onDone }: { o: IOrder; action: 'fix' | 'cancel'; onClose: () => void; onDone: () => Promise<void> }) {
  const [note, setNote] = useState('');
  const [fault, setFault] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit() {
    setBusy(true); setErr(null);
    try { await api(`/api/issues/${o.id}`, { method: 'POST', json: { action, note, fault } }); await onDone(); } catch (e) { setErr(msg(e)); setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`№${o.number} — ${action === 'fix' ? 'Зассан' : 'Цуцлах'}`} subtitle={action === 'fix' ? 'Тайлбар жолоочид харагдана (жишээ: зөв утас, хаяг)' : 'Бараа жолоочид өгөгдсөн бол түүнд үлдэж агуулахад буцна'}
      footer={<><Button variant="ghost" onClick={onClose}>Болих</Button><Button variant={action === 'fix' ? 'primary' : 'danger'} loading={busy} disabled={note.trim().length < 5 || (action === 'cancel' && !fault)} onClick={submit}>{action === 'fix' ? 'Зассан' : 'Цуцлах'}</Button></>}>
      <div className="flex flex-col gap-3">
        {action === 'cancel' ? <div className="grid grid-cols-2 gap-2">{FAULTS.map(([k, l]) => <Button key={k} variant={fault === k ? 'dark' : 'secondary'} onClick={() => setFault(k)}>{l}</Button>)}</div> : null}
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-autofocus placeholder="Тайлбар (5+ тэмдэгт)" className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[14px]" />
        {err ? <Notice>{err}</Notice> : null}
      </div>
    </Modal>
  );
}
