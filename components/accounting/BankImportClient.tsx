'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Badge } from '@/components/ui/Badge';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';
import { GmailSettings } from './GmailSettings';

/**
 * Банкны импорт (Модуль 6, хуучнаар нь, #83; #148 — зөвхөн Gmail): Хаан банкны Gmail → утас + дүнгээр «Төлбөр хүлээж буй» захиалга «Мөнгө орсон».
 * Статистик, табууд, хайлт, «Гараар тааруулах», «Буцаасан», «Дүн өөрчлөгдсөн», CSV экспорт.
 */
interface RefundReq { id: number; requestedByName: string; requestedAt: string; bankName: string; accountNo: string; accountName: string; amount: number }
type RefundKind = 'TX' | 'EXCESS' | 'ORDER_EXCESS' | 'PAID_CANCELLED';
interface RefundTarget { kind: RefundKind; id: number; amount: number; title: string }
interface ManualEx { id: number; number: string; phone: string; total: number; paidAmount: number; excess: number; why: string; refundReq?: RefundReq | null }
interface Tx { why?: string | null; id: number; txDate: string; description: string; amount: number; phone: string | null; status: string; statusLabel: string; isDuplicate: boolean; refunded: boolean; excess?: number; excessRefunded: number; excessRefundedByName: string | null; source: string; matchedByName: string | null; importedByName: string; refundReq?: RefundReq | null; order: { id: number; number: string; total: number; status: string; prepaid: boolean } | null }
interface ListResp { page: number; total: number; pages: number; canEdit: boolean; canSetup?: boolean; canRequestRefund?: boolean; items: Tx[]; manualExcess?: ManualEx[] }
type Agg = { count: number; amount: number };
interface Stats { total: Agg; matched: Agg; unmatched: Agg; partial: Agg; excess: Agg; duplicate: Agg; refunded: Agg }
interface Gmail { configured: boolean; canEdit: boolean; canSetup?: boolean; settings: null | { email: string; sender: string; autoSync: boolean; minutes: number; days: number; lastSyncAt: string | null; lastResult: string | null; lastOk: boolean | null } }
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const TABS: [string, string, keyof Stats | null][] = [['all', 'Бүгд', 'total'], ['MATCHED', 'Таарсан', 'matched'], ['UNMATCHED', 'Таараагүй', 'unmatched'], ['PARTIAL_PAYMENT', 'Хэсэгчлэн', 'partial'], ['EXCESS_AMOUNT', 'Илүү', 'excess'], ['DUPLICATE', 'Давхардсан', 'duplicate'], ['REFUNDED', 'Буцаасан', 'refunded'], ['changes', 'Дүн өөрчлөгдсөн', null]];
const TONE: Record<string, 'ok' | 'bad' | 'warn' | 'info' | 'neutral' | 'accent'> = { MATCHED: 'ok', UNMATCHED: 'bad', PARTIAL_PAYMENT: 'warn', EXCESS_AMOUNT: 'info', DUPLICATE: 'neutral' };
const ST_L: Record<string, string> = { PENDING_PAYMENT: 'Төлбөр хүлээж буй', NEW: 'Шинэ', ASSIGNED: 'Оноосон', OUT_FOR_DELIVERY: 'Хүргэлтэд', DELIVERED: 'Хүргэсэн', CANCELLED: 'Цуцлагдсан' };

interface PaidCancel { id: number; number: string; phone: string; total: number; paid: number; cancelReason: string | null; cancelNote: string | null; cancelledByName: string | null; cancelledAt: string | null; driverName: string | null; refundReq?: RefundReq | null }

export function BankImportClient() {
  // #201: дээд талын анхааруулгаас ?tab=UNMATCHED гэх мэтээр шууд тухайн табыг нээнэ
  // #211: URL-аас табыг mount-ийн дараа уншина (SSR-тэй зөрөхөөс сэргийлнэ — өмнө нь «Бүгд» тодорч харагддаг байв)
  const [tab, setTab] = useState<string | null>(null);
  useEffect(() => { const t = new URLSearchParams(window.location.search).get('tab'); setTab(t && (t === 'paidCancelled' || t === 'refunds' || TABS.some(([k]) => k === t)) ? t : 'all'); }, []);
  // Аудит #155: төлсөн ч жолооч / асуудлаар цуцлагдсан — зөвхөн Супер админд (403 бол таб харагдахгүй)
  const [pc, setPc] = useState<PaidCancel[] | null>(null);
  const [pcResolve, setPcResolve] = useState(false);
  // #211: мөнгө буцаах хүсэлт
  const [rfTarget, setRfTarget] = useState<RefundTarget | null>(null);
  const [rfPending, setRfPending] = useState<number | null>(null);
  const [rfVer, setRfVer] = useState(0);
  const [pcNote, setPcNote] = useState<{ id: number; number: string; note: string } | null>(null);
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResp | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [changes, setChanges] = useState<{ total: number; page: number; items: { id: number; number: string; phone: string; total: number; paid: number; diff: number; status: string; operatorName: string; updatedAt: string }[] } | null>(null);
  const [gmail, setGmail] = useState<Gmail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [match, setMatch] = useState<Tx | null>(null);
  const [gset, setGset] = useState(false);
  useEffect(() => { const t = setTimeout(() => { setQd(q); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const qs = useCallback(() => new URLSearchParams({ ...(tab && tab !== 'all' && tab !== 'changes' && tab !== 'paidCancelled' && tab !== 'refunds' ? { tab } : {}), ...(qd ? { q: qd } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }), [tab, qd, from, to]);
  const load = useCallback(async () => {
    if (tab === null) return;
    try {
      const p = qs();
      const [s, g] = await Promise.all([api<Stats>(`/api/bank/stats?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`), api<Gmail>('/api/bank/gmail')]);
      setStats(s); setGmail(g);
      api<{ items: PaidCancel[]; canResolve?: boolean }>('/api/bank/paid-cancelled').then((r) => { setPc(r.items); setPcResolve(!!r.canResolve); }).catch(() => setPc(null));
      api<{ counts: Record<string, number> }>('/api/bank/refunds?status=PENDING').then((r) => setRfPending(r.counts.PENDING ?? 0)).catch(() => setRfPending(null));
      setRfVer((v) => v + 1);
      if (tab === 'paidCancelled' || tab === 'refunds') { /* жагсаалтыг тусад нь уншина */ }
      else if (tab === 'changes') setChanges(await api(`/api/bank/price-changes?page=${page}`));
      else { p.set('page', String(page)); setData(await api(`/api/bank?${p}`)); }
      setErr(null);
    } catch (e) { setErr(msg(e)); }
  }, [qs, tab, page, from, to]);
  useEffect(() => { void load(); }, [load]);

  const sync = async () => {
    setBusy(true); setErr(null); setInfo(null);
    try { const r = await api<{ emails: number; imported: number; matched: number; duplicates: number; skipped: number }>('/api/bank/gmail', { method: 'POST', json: { action: 'sync' } }); setInfo(`Gmail: ${r.emails} имэйл · ${r.imported} импорт · ${r.matched} таарсан · ${r.duplicates} давхардсан · ${r.skipped} алгассан`); await load(); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const refundExcess = async (t: Tx) => {
    if (!t.excess || !confirm(`№${t.order?.number} захиалгын илүү төлсөн ${t.excess.toLocaleString('en-US')}₮-ийг үйлчлүүлэгчид буцааж өгсөн үү?\n\nАнхаар: дараа нь болиулах боломжгүй.`)) return;
    try { await api(`/api/bank/${t.id}/refund-excess`, { method: 'POST', json: {} }); await load(); } catch (e) { setErr(msg(e)); }
  };
  const refundManual = async (o: ManualEx) => {
    if (!confirm(`№${o.number} захиалгын илүү төлсөн ${o.excess.toLocaleString('en-US')}₮-ийг үйлчлүүлэгчид буцааж өгсөн үү?\n\nАнхаар: дараа нь болиулах боломжгүй.`)) return;
    try { await api(`/api/bank/${o.id}/order-refund-excess`, { method: 'POST', json: {} }); await load(); } catch (e) { setErr(msg(e)); }
  };
  const refund = async (t: Tx) => {
    if (!confirm(`${t.amount.toLocaleString('en-US')}₮-ийн гүйлгээг «Буцаасан» гэж тэмдэглэх үү?\n\nАнхаар: дараа нь болиулах, захиалгад тааруулах боломжгүй.`)) return;
    try { await api(`/api/bank/${t.id}/refund`, { method: 'POST', json: { refunded: true } }); await load(); } catch (e) { setErr(msg(e)); }
  };
  const canEdit = !!data?.canEdit || !!gmail?.canEdit;
  const canReq = !!data?.canRequestRefund;
  /** #211: «💸 Буцаах хүсэлт» товч эсвэл хүлээгдэж буй хүсэлтийн тэмдэг */
  const reqCell = (r: RefundReq | null | undefined, t: RefundTarget | null) => r
    ? <span data-refund-pending className="inline-block max-w-[220px] rounded-lg bg-warn-soft px-2 py-1 text-left text-[11.5px] font-semibold text-warn [overflow-wrap:anywhere]">⏳ Буцаах хүсэлт · {r.requestedByName}<span className="block font-normal">{r.bankName} {r.accountNo} · {r.accountName}</span></span>
    : t && canReq ? <Button size="sm" variant="secondary" data-refund-request onClick={() => setRfTarget(t)}>💸 Буцаах хүсэлт</Button> : null;
  // #173: Gmail тохиргоо, CSV экспорт — оператор, ахлах операторт харагдахгүй
  const canSetup = !!data?.canSetup || !!gmail?.canSetup || !!gmail?.canEdit;

  return (
    <div className="flex flex-col gap-4">
      <div data-page-band className="page-band rounded-[16px] px-4 py-3.5 shadow-card md:px-5 md:py-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0"><h1 className="text-[24px] font-extrabold tracking-tight">Банкны импорт</h1><p className="band-sub text-[13.5px]">Хаан банкны орлого → утас + дүнгээр «Төлбөр хүлээж буй» захиалга «Мөнгө орсон» (дугаар солигдохгүй)</p></div>
        <div className="band-actions flex flex-wrap gap-2">
          {canEdit ? <>
            <Button variant="primary" size="sm" loading={busy} disabled={!gmail?.configured} onClick={() => void sync()} title={gmail?.configured ? '' : 'Gmail холбогдоогүй — «Gmail тохиргоо»'}>Gmail sync</Button>
            {canSetup ? <Button size="sm" onClick={() => setGset(true)}>Gmail тохиргоо</Button> : null}</> : null}
          {canSetup ? <a href={`/api/bank/export?${qs()}`} className="inline-flex h-9 items-center rounded-[11px] border border-line bg-surface px-3 text-[13px] font-semibold hover:bg-surface2">CSV экспорт</a> : null}
        </div>
      </div>
      {gmail?.settings ? <p className="text-[12.5px] text-subtle">{gmail.configured ? `Gmail ${gmail.settings.email}${gmail.settings.autoSync ? ` · автомат ${gmail.settings.minutes} мин тутам` : ' · автомат унтраалттай'}${gmail.settings.lastSyncAt ? ` · сүүлд ${ubDateTime(gmail.settings.lastSyncAt)}: ${gmail.settings.lastResult ?? ''}` : ''}` : 'Gmail холбогдоогүй — «Gmail тохиргоо» дээр хаяг, 16 оронтой App Password, илгээгчийн Gmail бичээд холбоно'}</p> : null}
      {err ? <Notice>{err}</Notice> : null}
      {info ? <Notice tone="ok">{info}</Notice> : null}
      {stats ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {([['Нийт', stats.total], ['Таарсан', stats.matched], ['Таараагүй', stats.unmatched], ['Хэсэгчлэн', stats.partial], ['Илүү', stats.excess], ['Давхардсан', stats.duplicate], ['Буцаасан', stats.refunded]] as const).map(([l, a]) => (
            <div key={l} className="min-w-0 rounded-[12px] border border-line bg-surface px-3 py-2"><div className="text-[11.5px] font-semibold text-subtle">{l}</div><div className="text-[18px] font-extrabold">{a.count}</div><div className="truncate text-[12px] text-muted">{money(a.amount)}</div></div>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex max-w-full gap-1.5 overflow-x-auto pb-1">{TABS.map(([k, l]) => <button key={k} onClick={() => { setTab(k); setPage(1); }} className={clsx('h-9 shrink-0 rounded-full border px-3 text-[13px] font-bold', tab === k ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-muted')}>{l}</button>)}
          {pc ? <button onClick={() => { setTab('paidCancelled'); setPage(1); }} className={clsx('h-9 shrink-0 rounded-full border px-3 text-[13px] font-bold', tab === 'paidCancelled' ? 'border-ink bg-ink text-on-ink' : pc.length ? 'border-warn bg-warn-soft text-warn' : 'border-line bg-surface text-muted')}>💰 Төлсөн ч цуцлагдсан ({pc.length})</button> : null}
          {rfPending !== null ? <button data-tab-refunds onClick={() => { setTab('refunds'); setPage(1); }} className={clsx('h-9 shrink-0 rounded-full border px-3 text-[13px] font-bold', tab === 'refunds' ? 'border-ink bg-ink text-on-ink' : rfPending ? 'border-warn bg-warn-soft text-warn' : 'border-line bg-surface text-muted')}>💸 Буцаах хүсэлт ({rfPending})</button> : null}</div>
        {tab !== 'changes' && tab !== 'paidCancelled' && tab !== 'refunds' ? <div className="ml-auto flex flex-wrap gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Утга, утас, дүн" className="h-9 w-[180px] rounded-[10px] border border-line bg-surface px-2 text-[13.5px]" aria-label="Хайх" />
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="h-9 rounded-[10px] border border-line bg-surface px-2 text-[13px]" aria-label="Эхлэх огноо" />
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="h-9 rounded-[10px] border border-line bg-surface px-2 text-[13px]" aria-label="Дуусах огноо" />
        </div> : null}
      </div>

      {tab === 'paidCancelled' ? (
        <div className="overflow-hidden rounded-[16px] border border-line bg-surface shadow-card">
          <p className="px-4 pt-3 text-[13px] text-muted">Жолооч эсвэл «Асуудлууд»-аар цуцлагдсан, мөнгө нь захиалгадаа наалдсан хэвээр захиалгууд. Шалтгааныг тогтоогоод (буцаах / өөр захиалгад тааруулах / дахин хүргэх) «Шийдсэн» гэж тэмдэглэнэ.</p>
          <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-[13px]">
            <thead className="bg-surface2 text-[12px] text-muted"><tr><th className="px-3 py-2 text-left">Захиалга</th><th className="px-3 py-2 text-left">Утас</th><th className="px-3 py-2 text-right">Дүн</th><th className="px-3 py-2 text-right">Төлсөн</th><th className="px-3 py-2 text-left">Хэн / хэзээ</th><th className="px-3 py-2 text-left">Шалтгаан</th><th className="px-3 py-2" /></tr></thead>
            <tbody className="divide-y divide-line">{pc?.slice((page - 1) * 25, page * 25).map((c) => (
              <tr key={c.id}><td className="px-3 py-2 font-bold">{c.number}</td><td className="px-3 py-2">{c.phone}</td><td className="px-3 py-2 text-right">{money(c.total)}</td><td className="px-3 py-2 text-right font-bold">{money(c.paid)}</td>
                <td className="max-w-[200px] px-3 py-2 [overflow-wrap:anywhere]">{c.cancelledByName ?? '—'}{c.driverName && c.driverName !== c.cancelledByName ? ` (жолооч ${c.driverName})` : ''}<div className="text-[12px] text-muted">{c.cancelledAt ? ubDateTime(c.cancelledAt) : ''}</div></td>
                <td className="max-w-[260px] px-3 py-2 [overflow-wrap:anywhere]">{c.cancelReason === 'ISSUE' ? 'Асуудал: ' : c.cancelReason === 'DRIVER_CANCELLED' ? 'Жолооч: ' : ''}{c.cancelNote ?? ''}</td>
                <td className="px-3 py-2 text-right"><div className="flex flex-wrap justify-end gap-1.5">{reqCell(c.refundReq, { kind: 'PAID_CANCELLED', id: c.id, amount: c.paid, title: `№${c.number} · ${c.phone}` })}{pcResolve ? <Button size="sm" variant="secondary" onClick={() => setPcNote({ id: c.id, number: c.number, note: '' })}>Шийдсэн</Button> : null}</div></td></tr>
            ))}</tbody></table></div>
          {pc && !pc.length ? <p className="px-4 py-10 text-center text-muted">Ийм захиалга алга</p> : null}
          {pc && pc.length ? <div className="border-t border-line"><Pager page={page} pages={Math.max(1, Math.ceil(pc.length / 25))} total={pc.length} unit="захиалга" onPage={setPage} /></div> : null}
        </div>
      ) : tab === 'refunds' ? (
        <RefundsTab ver={rfVer} onChanged={() => void load()} onInfo={setInfo} />
      ) : tab === 'changes' ? (
        <div className="overflow-hidden rounded-[16px] border border-line bg-surface shadow-card">
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-[13px]">
            <thead className="bg-surface2 text-[12px] text-muted"><tr><th className="px-3 py-2 text-left">Захиалга</th><th className="px-3 py-2 text-left">Утас</th><th className="px-3 py-2 text-right">Одоогийн дүн</th><th className="px-3 py-2 text-right">Төлсөн</th><th className="px-3 py-2 text-right">Зөрүү</th><th className="px-3 py-2 text-left">Төлөв</th><th className="px-3 py-2 text-left">Оператор</th></tr></thead>
            <tbody className="divide-y divide-line">{changes?.items.map((c) => (
              <tr key={c.id}><td className="px-3 py-2 font-bold">{c.number}</td><td className="px-3 py-2">{c.phone}</td><td className="px-3 py-2 text-right">{money(c.total)}</td><td className="px-3 py-2 text-right">{money(c.paid)}</td>
                <td className={clsx('px-3 py-2 text-right font-bold', c.diff < 0 ? 'text-bad-ink' : 'text-info')}>{c.diff > 0 ? '+' : ''}{money(c.diff)}</td><td className="px-3 py-2">{ST_L[c.status] ?? c.status}</td><td className="max-w-[180px] px-3 py-2 [overflow-wrap:anywhere]">{c.operatorName}</td></tr>
            ))}</tbody></table></div>
          {changes && !changes.items.length ? <p className="px-4 py-10 text-center text-muted">Дүн зөрсөн захиалга алга</p> : null}
          {changes && changes.total > 0 ? <div className="border-t border-line"><Pager page={page} pages={Math.max(1, Math.ceil(changes.total / 50))} total={changes.total} unit="захиалга" onPage={setPage} /></div> : null}
        </div>
      ) : (
        <>
        {tab === 'EXCESS_AMOUNT' && data?.manualExcess?.length ? (
          <div className="mb-3 rounded-[16px] border border-info/40 bg-info-soft p-3 text-[13px]" data-manual-excess>
            <div className="mb-1 font-bold">Банкны гүйлгээгүй илүү төлөлт ({data.manualExcess.length}) — гараар «Мөнгө орсон» болгосон, дараа нь дүн буурсан</div>
            <ul className="divide-y divide-line/60">
              {data.manualExcess.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]"><b>№{o.number}</b> · {o.phone} · төлсөн {money(o.paidAmount)} / дүн {money(o.total)}<span className="block text-[12px] text-muted">{o.why}</span></span>
                  <span className="flex flex-wrap gap-1.5">{reqCell(o.refundReq, { kind: 'ORDER_EXCESS', id: o.id, amount: o.excess, title: `№${o.number} · ${o.phone} · илүү төлөлт` })}
                  {canEdit ? <Button size="sm" variant="primary" onClick={() => void refundManual(o)}>Илүүг буцаасан ({o.excess.toLocaleString('en-US')}₮)</Button> : null}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="overflow-hidden rounded-[16px] border border-line bg-surface shadow-card">
          {data && data.pages > 1 ? <div className="border-b border-line"><Pager page={page} pages={data.pages} total={data.total} unit="гүйлгээ" onPage={setPage} /></div> : null}
          <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-[13px]">
            <thead className="bg-surface2 text-[12px] text-muted"><tr><th className="px-3 py-2 text-left">Огноо</th><th className="px-3 py-2 text-left">Гүйлгээний утга</th><th className="px-3 py-2 text-right">Дүн</th><th className="px-3 py-2 text-left">Утас</th><th className="px-3 py-2 text-left">Төлөв</th><th className="px-3 py-2 text-left">Захиалга</th><th className="px-3 py-2" /></tr></thead>
            <tbody className="divide-y divide-line">{data?.items.map((t) => (
              <tr key={t.id} className="align-top">
                <td className="px-3 py-2 whitespace-nowrap text-[12.5px]">{ubDateTime(t.txDate)}<span className="block text-[11px] text-subtle">{t.source === 'GMAIL' ? 'Gmail' : 'CSV'}</span></td>
                <td className="max-w-[320px] px-3 py-2 [overflow-wrap:anywhere]">{t.description}</td>
                <td className="px-3 py-2 text-right font-bold whitespace-nowrap">{money(t.amount)}</td>
                <td className="px-3 py-2">{t.phone ?? '—'}</td>
                <td className="px-3 py-2"><Badge tone={t.refunded ? 'accent' : TONE[t.isDuplicate ? 'DUPLICATE' : t.status] ?? 'neutral'}>{t.statusLabel}</Badge>{t.matchedByName ? <span className="block text-[11px] text-subtle">{t.matchedByName}</span> : null}</td>
                <td className="max-w-[260px] px-3 py-2">{t.order ? <><b>{t.order.number}</b><span className="block text-[11.5px] text-subtle">{money(t.order.total)} · {ST_L[t.order.status] ?? t.order.status}</span>{t.excess && t.why ? <span className="block text-[11.5px] text-info [overflow-wrap:anywhere]">{t.why}</span> : null}</> : '—'}</td>
                <td className="px-3 py-2 text-right"><div className="flex flex-wrap justify-end gap-1.5">{t.refunded ? null : reqCell(t.refundReq, t.order ? (t.excess ? { kind: 'EXCESS', id: t.id, amount: t.excess, title: `№${t.order.number} · илүү төлөлт` } : null) : { kind: 'TX', id: t.id, amount: t.amount, title: `${ubDateTime(t.txDate)} · ${t.isDuplicate ? 'давхардсан' : 'таараагүй'} гүйлгээ` })}</div>
                  {data.canEdit ? <div className="mt-1.5 flex justify-end gap-1.5">{t.refunded ? <span className="text-[12px] text-subtle">Буцаасан — өөрчлөхгүй</span>
                  : t.order ? (t.excess ? <Button size="sm" variant="primary" data-refund-excess onClick={() => void refundExcess(t)}>Илүүг буцаасан ({t.excess.toLocaleString('en-US')}₮)</Button>
                    : <span className="text-[12px] text-subtle">{t.excessRefunded ? `Илүү ${t.excessRefunded.toLocaleString('en-US')}₮ буцаасан${t.excessRefundedByName ? ` · ${t.excessRefundedByName}` : ''}` : 'Таарсан — өөрчлөхгүй'}</span>)
                  : <><Button size="sm" onClick={() => setMatch(t)}>Гараар тааруулах</Button><Button size="sm" variant="ghost" onClick={() => void refund(t)}>Буцаасан</Button></>}</div> : null}</td>
              </tr>
            ))}</tbody></table></div>
          {data && !data.items.length ? <p className="px-4 py-10 text-center text-muted">Гүйлгээ алга</p> : null}
          {data ? <div className="border-t border-line"><Pager page={page} pages={data.pages} total={data.total} unit="гүйлгээ" onPage={(n) => { setPage(n); window.scrollTo({ top: 0, behavior: 'smooth' }); }} /></div> : null}
        </div>
        </>
      )}
      {pcNote ? (
        <Modal open onClose={() => setPcNote(null)} title={`«Шийдсэн» · ${pcNote.number}`} subtitle="Юу болсныг товч бичнэ (түүхэнд үлдэнэ)"
          footer={<><Button onClick={() => setPcNote(null)}>Болих</Button><Button variant="primary" loading={busy} disabled={pcNote.note.trim().length < 3} onClick={async () => {
            setBusy(true); setErr(null);
            try { await api('/api/bank/paid-cancelled', { method: 'POST', json: { id: pcNote.id, note: pcNote.note } }); setPcNote(null); setInfo(`№${pcNote.number} шийдсэн гэж тэмдэглэлээ`); await load(); }
            catch (e) { setErr(msg(e)); } finally { setBusy(false); }
          }}>Хадгалах</Button></>}>
          <textarea value={pcNote.note} onChange={(e) => setPcNote({ ...pcNote, note: e.target.value })} rows={3} maxLength={300} className="w-full rounded-[10px] border border-line bg-surface p-2 text-[13.5px]" placeholder="Жишээ: мөнгийг буцаасан / дараагийн захиалгад тааруулсан" aria-label="Тайлбар" />
        </Modal>
      ) : null}
      {rfTarget ? <RefundRequestDialog target={rfTarget} onClose={() => setRfTarget(null)} onDone={async () => { setRfTarget(null); setInfo('Буцаах хүсэлт илгээгдлээ — Супер админ / Нягтлан шалгаад мөнгийг шилжүүлнэ'); await load(); }} /> : null}
      {match ? <MatchDialog t={match} onClose={() => setMatch(null)} onDone={async (m) => { setMatch(null); setInfo(m); await load(); }} /> : null}
      {gset ? <GmailSettingsModal onClose={() => setGset(false)} onDone={() => void load()} /> : null}
    </div>
  );
}

function MatchDialog({ t, onClose, onDone }: { t: Tx; onClose: () => void; onDone: (m: string) => void }) {
  const [q, setQ] = useState(t.phone ?? '');
  const [items, setItems] = useState<{ id: number; number: string; phone: string; total: number; status: string; paid: number; createdAt: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<(typeof items)[number] | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    const h = setTimeout(async () => { try { setItems((await api<{ items: typeof items }>(`/api/bank/orders?q=${encodeURIComponent(q)}`)).items); } catch (e) { setErr(msg(e)); } }, 250);
    return () => clearTimeout(h);
  }, [q]);
  const go = async (number: string) => {
    setBusy(true); setErr(null);
    try { const r = await api<{ paid: number; total: number; paidMarked: boolean }>(`/api/bank/${t.id}/match`, { method: 'POST', json: { orderNumber: number, note } }); onDone(`№${number}: төлсөн ${money(r.paid)} / ${money(r.total)}${r.paidMarked ? ' — «Мөнгө орсон» боллоо' : ''}`); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Гараар тааруулах" subtitle={`${money(t.amount)} · ${t.description.slice(0, 80)}`} footer={<Button onClick={onClose}>Болих</Button>}>
      <input data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Утас эсвэл захиалгын дугаар" className="h-11 w-full rounded-xl border border-line bg-surface px-3" aria-label="Хайх" inputMode="numeric" />
      {err ? <div className="mt-2"><Notice>{err}</Notice></div> : null}
      <div className="mt-2 divide-y divide-line rounded-[12px] border border-line">
        {items.map((o) => (
          <div key={o.id} className="flex items-center justify-between gap-2 px-3 py-2 text-[13px]">
            <span className="min-w-0"><b>{o.number}</b> · {o.phone}<span className="block text-[12px] text-subtle">{money(o.total)} · {ST_L[o.status] ?? o.status}{o.paid ? ` · төлсөн ${money(o.paid)}` : ''} · {ubDateTime(o.createdAt)}</span></span>
            <Button size="sm" variant="primary" loading={busy} onClick={() => setPick(o)}>Холбох</Button>
          </div>
        ))}
        {!items.length ? <p className="px-3 py-4 text-center text-[13px] text-muted">«Төлбөр хүлээж буй» захиалга олдсонгүй</p> : null}
      </div>
      {pick ? (
        // Аудит Б8: тааруулахаас өмнө гүйлгээ ↔ захиалгыг зэрэгцүүлж батлуулна (таарсан бол буцаахгүй — #127)
        <div role="dialog" aria-label="Тааруулахыг батлах" className="mt-3 rounded-[12px] border border-warn/50 bg-warn-soft p-3 text-[13px]">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="min-w-0"><div className="text-[11.5px] font-bold text-subtle">ГҮЙЛГЭЭ</div><b>{money(t.amount)}</b><span className="block [overflow-wrap:anywhere]">{t.description}</span>{t.phone ? <span className="block text-muted">Утас: {t.phone}</span> : null}</div>
            <div className="min-w-0"><div className="text-[11.5px] font-bold text-subtle">ЗАХИАЛГА</div><b>№{pick.number}</b><span className="block">Утас: {pick.phone}</span><span className="block">Дүн {money(pick.total)}{pick.paid ? ` · өмнө төлсөн ${money(pick.paid)}` : ''}</span></div>
          </div>
          {(t.phone && t.phone !== pick.phone) || t.isDuplicate ? (<>
            {t.isDuplicate ? <p className="mt-2 font-semibold text-bad-ink">Анхаар: энэ гүйлгээ «Давхардсан» (ижил өдөр, дүн, утастай өөр гүйлгээ аль хэдийн орсон). Нэг мөнгө хоёр захиалгад орохгүйн тулд үнэхээр өөр мөнгө эсэхийг шалгаад шалтгаанаа бичнэ үү.</p> : null}
            {t.phone && t.phone !== pick.phone ? <p className="mt-2 font-semibold text-bad-ink">Анхаар: гүйлгээний утас захиалгын утастай таарахгүй байна. Итгэлтэй бол шалтгаанаа бичнэ үү (түүхэнд үлдэнэ).</p> : null}
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Жишээ: ах нь өөрийн данснаас шилжүүлсэн" aria-label="Шалтгаан" className="mt-1 h-10 w-full rounded-lg border border-line bg-surface px-2" />
          </>) : null}
          <p className="mt-2 text-muted">Тааруулсны дараа өөрчлөх боломжгүй.</p>
          <div className="mt-2 flex flex-wrap justify-end gap-2"><Button size="sm" onClick={() => setPick(null)}>Болих</Button><Button size="sm" variant="primary" loading={busy} disabled={((!!t.phone && t.phone !== pick.phone) || t.isDuplicate) && note.replace(/\s/g, '').length < 5} onClick={() => void go(pick.number)}>Тийм, тааруулах</Button></div>
        </div>
      ) : null}
    </Modal>
  );
}

function GmailSettingsModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  return (
    <Modal open onClose={() => { onClose(); onDone(); }} size="xl" title="Gmail — Хаан банкны мэдэгдэл" subtitle="Gmail хаяг, 16 оронтой App Password бичээд «Хадгалаад Sync»" footer={<Button onClick={() => { onClose(); onDone(); }}>Хаах</Button>}>
      <GmailSettings onSynced={onDone} />
    </Modal>
  );
}

/** #172-8: хуудаслалт — эхний / өмнөх / дугаарууд / дараах / сүүлийн */
function Pager({ page, pages, total, unit, onPage }: { page: number; pages: number; total: number; unit: string; onPage: (p: number) => void }) {
  if (pages <= 1) return <div className="px-3 py-2 text-[13px] text-muted">{total} {unit}</div>;
  const nums = [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  return (
    <div data-pager className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]">
      <span className="text-muted">{total} {unit} · {page}/{pages} хуудас</span>
      <div className="flex flex-wrap items-center gap-1">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Өмнөх">‹</Button>
        {nums.map((n, i) => (
          <span key={n} className="flex items-center gap-1">
            {i > 0 && n - nums[i - 1]! > 1 ? <span className="text-subtle">…</span> : null}
            <button type="button" onClick={() => onPage(n)} aria-current={n === page ? 'page' : undefined}
              className={clsx('h-9 min-w-[36px] rounded-lg border px-2 font-semibold', n === page ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface hover:bg-surface2')}>{n}</button>
          </span>
        ))}
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Дараах">›</Button>
      </div>
    </div>
  );
}

/** #211: «💸 Буцаах хүсэлт» — банк, данс, эзний нэр, шалтгаан (оператор, ахлах оператор) */
function RefundRequestDialog({ target, onClose, onDone }: { target: RefundTarget; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ bankName: '', accountNo: '', accountName: '', reason: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const acc = f.accountNo.replace(/[\s-]/g, '').toUpperCase();
  const accOk = /^(MN\d{18}|\d{6,20})$/.test(acc);
  const ok = f.bankName.trim().length >= 2 && accOk && f.accountName.trim().length >= 2 && f.reason.trim().length >= 5;
  const inp = 'h-11 w-full rounded-xl border border-line bg-surface px-3 text-[14px]';
  const send = async () => {
    setBusy(true); setErr(null);
    try { await api('/api/bank/refunds', { method: 'POST', json: { action: 'create', kind: target.kind, id: target.id, ...f } }); onDone(); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="💸 Мөнгө буцаах хүсэлт" subtitle={`${target.title} · ${money(target.amount)}`}
      footer={<><Button onClick={onClose}>Болих</Button><Button variant="primary" loading={busy} disabled={!ok} onClick={() => void send()} data-refund-send>Хүсэлт илгээх</Button></>}>
      <div className="flex flex-col gap-3 text-[13.5px]" data-refund-form>
        {err ? <Notice>{err}</Notice> : null}
        <p className="rounded-xl bg-surface2 px-3 py-2 text-muted">Буцаах дүн: <b className="text-ink">{money(target.amount)}</b> (систем тооцно). Супер админ эсвэл Нягтлан шалгаад мөнгийг шилжүүлнэ.</p>
        <label className="flex flex-col gap-1"><span className="font-semibold">Банк</span>
          <input list="refund-banks" value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} maxLength={60} className={inp} placeholder="Жишээ: Хаан банк" data-autofocus />
          <datalist id="refund-banks">{['Хаан банк', 'Голомт банк', 'Төрийн банк', 'Худалдаа хөгжлийн банк', 'Хас банк', 'Капитрон банк', 'Ариг банк', 'Богд банк', 'Тээвэр хөгжлийн банк', 'М банк', 'Чингис хаан банк'].map((b) => <option key={b} value={b} />)}</datalist></label>
        <label className="flex flex-col gap-1"><span className="font-semibold">Дансны дугаар</span>
          <input value={f.accountNo} onChange={(e) => setF({ ...f, accountNo: e.target.value })} maxLength={30} className={inp} placeholder="Зөвхөн цифр эсвэл MN… IBAN" />
          {f.accountNo && !accOk ? <span className="text-[12px] text-bad-ink">Зөвхөн цифр (6–20 орон) эсвэл MN + 18 цифр</span> : null}</label>
        <label className="flex flex-col gap-1"><span className="font-semibold">Дансны эзний нэр</span>
          <input value={f.accountName} onChange={(e) => setF({ ...f, accountName: e.target.value })} maxLength={100} className={inp} /></label>
        <label className="flex flex-col gap-1"><span className="font-semibold">Яагаад буцаах вэ</span>
          <textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} rows={3} maxLength={500} className="w-full rounded-xl border border-line bg-surface p-3 text-[14px]" placeholder="Жишээ: үйлчлүүлэгч захиалгаа цуцалсан, мөнгөө буцааж авна" /></label>
      </div>
    </Modal>
  );
}

interface RefundRow { id: number; kind: string; kindLabel: string; orderNumber: string | null; amount: number; bankName: string; accountNo: string; accountName: string; reason: string; status: string; requestedByName: string; requestedAt: string; decidedByName: string | null; decidedAt: string | null; decisionNote: string | null; tx: { id: number; txDate: string; amount: number } | null }

/** #211: «💸 Буцаах хүсэлт» таб — хүлээгдэж буй / буцаасан / татгалзсан; Супер админ, Нягтлан шийднэ */
function RefundsTab({ ver, onChanged, onInfo }: { ver: number; onChanged: () => void; onInfo: (m: string) => void }) {
  const [st, setSt] = useState<'PENDING' | 'DONE' | 'REJECTED'>('PENDING');
  const [page, setPage] = useState(1);
  const [d, setD] = useState<{ page: number; total: number; pages: number; canDecide: boolean; counts: Record<string, number>; items: RefundRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rej, setRej] = useState<{ id: number; note: string } | null>(null);
  const load = useCallback(async () => { try { setD(await api(`/api/bank/refunds?status=${st}&page=${page}`)); setErr(null); } catch (e) { setErr(msg(e)); } }, [st, page]);
  useEffect(() => { void load(); }, [load, ver]);
  const act = async (json: Record<string, unknown>, ok: string) => {
    setBusy(true); setErr(null);
    try { await api('/api/bank/refunds', { method: 'POST', json }); onInfo(ok); setRej(null); await load(); onChanged(); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const done = (r: RefundRow) => {
    if (!confirm(`${money(r.amount)}-ийг ${r.bankName} ${r.accountNo} (${r.accountName}) дансанд шилжүүлсэн үү?\n\nАнхаар: «Буцаасан» болсны дараа болиулах боломжгүй.`)) return;
    void act({ action: 'done', id: r.id }, `${money(r.amount)} буцаасан гэж тэмдэглэлээ`);
  };
  const SL: Record<string, string> = { PENDING: 'Хүлээгдэж буй', DONE: 'Буцаасан', REJECTED: 'Татгалзсан' };
  return (
    <div className="overflow-hidden rounded-[16px] border border-line bg-surface shadow-card" data-refunds>
      <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2.5">
        {(['PENDING', 'DONE', 'REJECTED'] as const).map((k) => <button key={k} onClick={() => { setSt(k); setPage(1); }} className={clsx('h-8 rounded-full border px-3 text-[12.5px] font-bold', st === k ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-muted')}>{SL[k]} ({d?.counts[k] ?? 0})</button>)}
      </div>
      {err ? <div className="p-3"><Notice>{err}</Notice></div> : null}
      <div className="overflow-x-auto"><table className="w-full min-w-[980px] table-fixed text-[13px]">
        <thead className="bg-surface2 text-[12px] text-muted"><tr><th className="w-[130px] px-3 py-2 text-left">Хүсэлт</th><th className="w-[150px] px-3 py-2 text-left">Юуны мөнгө</th><th className="w-[110px] px-3 py-2 text-right">Дүн</th><th className="w-[200px] px-3 py-2 text-left">Данс</th><th className="px-3 py-2 text-left">Шалтгаан</th><th className="w-[190px] px-3 py-2 text-right" /></tr></thead>
        <tbody className="divide-y divide-line">{d?.items.map((r) => (
          <tr key={r.id} className="align-top">
            <td className="px-3 py-2 [overflow-wrap:anywhere]">{r.requestedByName}<span className="block text-[11.5px] text-subtle">{ubDateTime(r.requestedAt)}</span></td>
            <td className="px-3 py-2 [overflow-wrap:anywhere]">{r.kindLabel}{r.orderNumber ? <b className="block">№{r.orderNumber}</b> : null}{r.tx ? <span className="block text-[11.5px] text-subtle">Гүйлгээ {ubDateTime(r.tx.txDate)} · {money(r.tx.amount)}</span> : null}</td>
            <td className="px-3 py-2 text-right font-extrabold">{money(r.amount)}</td>
            <td className="px-3 py-2 [overflow-wrap:anywhere]"><b>{r.accountNo}</b><span className="block">{r.bankName}</span><span className="block text-muted">{r.accountName}</span></td>
            <td className="px-3 py-2 [overflow-wrap:anywhere]">{r.reason}</td>
            <td className="px-3 py-2 text-right">{r.status === 'PENDING'
              ? (d.canDecide ? <div className="flex flex-wrap justify-end gap-1.5"><Button size="sm" variant="primary" loading={busy} data-refund-done onClick={() => done(r)}>Буцаасан</Button><Button size="sm" variant="ghost" data-refund-reject onClick={() => setRej({ id: r.id, note: '' })}>Татгалзах</Button></div> : <span className="text-[12px] text-subtle">Шалгаж байна</span>)
              : <span className={clsx('block text-[12px] [overflow-wrap:anywhere]', r.status === 'DONE' ? 'text-ok-ink' : 'text-bad-ink')}>{SL[r.status]} · {r.decidedByName}<span className="block text-subtle">{r.decidedAt ? ubDateTime(r.decidedAt) : ''}</span>{r.decisionNote ? <span className="block text-ink">{r.decisionNote}</span> : null}</span>}</td>
          </tr>
        ))}</tbody></table></div>
      {d && !d.items.length ? <p className="px-4 py-10 text-center text-muted">Хүсэлт алга</p> : null}
      {d && d.total > 0 ? <div className="border-t border-line"><Pager page={page} pages={d.pages} total={d.total} unit="хүсэлт" onPage={setPage} /></div> : null}
      {rej ? (
        <Modal open onClose={() => setRej(null)} title="Хүсэлтээс татгалзах" subtitle="Шалтгааныг бичнэ (оператор харна, түүхэнд үлдэнэ)"
          footer={<><Button onClick={() => setRej(null)}>Болих</Button><Button variant="danger" loading={busy} disabled={rej.note.trim().length < 3} onClick={() => void act({ action: 'reject', id: rej.id, note: rej.note }, 'Хүсэлтээс татгалзлаа')}>Татгалзах</Button></>}>
          <textarea value={rej.note} onChange={(e) => setRej({ ...rej, note: e.target.value })} rows={3} maxLength={300} className="w-full rounded-[10px] border border-line bg-surface p-2 text-[13.5px]" placeholder="Жишээ: дансны дугаар буруу, дахин шалгаад илгээнэ үү" aria-label="Шалтгаан" />
        </Modal>
      ) : null}
    </div>
  );
}
