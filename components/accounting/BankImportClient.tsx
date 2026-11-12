'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Badge } from '@/components/ui/Badge';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';
import { GmailSettings } from './GmailSettings';

/**
 * Банкны импорт (Модуль 6, хуучнаар нь, #83): Хаан банкны CSV / Gmail → утас + дүнгээр «Төлбөр хүлээж буй» захиалга «Мөнгө орсон».
 * Статистик, табууд, хайлт, «Гараар тааруулах», «Буцаасан», «Дүн өөрчлөгдсөн», CSV экспорт.
 */
interface Tx { id: number; txDate: string; description: string; amount: number; phone: string | null; status: string; statusLabel: string; isDuplicate: boolean; refunded: boolean; source: string; matchedByName: string | null; importedByName: string; order: { id: number; number: string; total: number; status: string; prepaid: boolean } | null }
interface ListResp { page: number; total: number; pages: number; canEdit: boolean; items: Tx[] }
type Agg = { count: number; amount: number };
interface Stats { total: Agg; matched: Agg; unmatched: Agg; partial: Agg; excess: Agg; duplicate: Agg; refunded: Agg }
interface Gmail { configured: boolean; canEdit: boolean; settings: { email: string; sender: string; autoSync: boolean; minutes: number; days: number; lastSyncAt: string | null; lastResult: string | null; lastOk: boolean | null } }
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const TABS: [string, string, keyof Stats | null][] = [['all', 'Бүгд', 'total'], ['MATCHED', 'Таарсан', 'matched'], ['UNMATCHED', 'Таараагүй', 'unmatched'], ['PARTIAL_PAYMENT', 'Хэсэгчлэн', 'partial'], ['EXCESS_AMOUNT', 'Илүү', 'excess'], ['DUPLICATE', 'Давхардсан', 'duplicate'], ['REFUNDED', 'Буцаасан', 'refunded'], ['changes', 'Дүн өөрчлөгдсөн', null]];
const TONE: Record<string, 'ok' | 'bad' | 'warn' | 'info' | 'neutral' | 'accent'> = { MATCHED: 'ok', UNMATCHED: 'bad', PARTIAL_PAYMENT: 'warn', EXCESS_AMOUNT: 'info', DUPLICATE: 'neutral' };
const ST_L: Record<string, string> = { PENDING_PAYMENT: 'Төлбөр хүлээж буй', NEW: 'Шинэ', ASSIGNED: 'Оноосон', OUT_FOR_DELIVERY: 'Хүргэлтэд', DELIVERED: 'Хүргэсэн', CANCELLED: 'Цуцлагдсан' };

export function BankImportClient() {
  const [tab, setTab] = useState('all');
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
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { const t = setTimeout(() => { setQd(q); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const qs = useCallback(() => new URLSearchParams({ ...(tab !== 'all' && tab !== 'changes' ? { tab } : {}), ...(qd ? { q: qd } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }), [tab, qd, from, to]);
  const load = useCallback(async () => {
    try {
      const p = qs();
      const [s, g] = await Promise.all([api<Stats>(`/api/bank/stats?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`), api<Gmail>('/api/bank/gmail')]);
      setStats(s); setGmail(g);
      if (tab === 'changes') setChanges(await api(`/api/bank/price-changes?page=${page}`));
      else { p.set('page', String(page)); setData(await api(`/api/bank?${p}`)); }
      setErr(null);
    } catch (e) { setErr(msg(e)); }
  }, [qs, tab, page, from, to]);
  useEffect(() => { void load(); }, [load]);

  const upload = async (f: File) => {
    setBusy(true); setErr(null); setInfo(null);
    try {
      const r = await api<{ imported: number; matched: number; partial: number; duplicates: number; debitsSkipped: number; badRows: number; errors: string[] }>('/api/bank/import', { method: 'POST', json: { text: await f.text() } });
      setInfo(`CSV импорт: ${r.imported} импорт · ${r.matched} таарсан («Мөнгө орсон») · ${r.partial} хэсэгчлэн · ${r.duplicates} давхардсан${r.debitsSkipped ? ` · ${r.debitsSkipped} зарлага алгассан` : ''}${r.badRows ? ` · ${r.badRows} буруу мөр` : ''}${r.errors.length ? ` · алдаа ${r.errors.length}` : ''}`);
      await load();
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); if (file.current) file.current.value = ''; }
  };
  const sync = async () => {
    setBusy(true); setErr(null); setInfo(null);
    try { const r = await api<{ emails: number; imported: number; matched: number; duplicates: number; skipped: number }>('/api/bank/gmail', { method: 'POST', json: { action: 'sync' } }); setInfo(`Gmail: ${r.emails} имэйл · ${r.imported} импорт · ${r.matched} таарсан · ${r.duplicates} давхардсан · ${r.skipped} алгассан`); await load(); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const refund = async (t: Tx) => {
    if (!confirm(`${t.amount.toLocaleString('en-US')}₮-ийн гүйлгээг «Буцаасан» гэж тэмдэглэх үү?\n\nАнхаар: дараа нь болиулах, захиалгад тааруулах боломжгүй.`)) return;
    try { await api(`/api/bank/${t.id}/refund`, { method: 'POST', json: { refunded: true } }); await load(); } catch (e) { setErr(msg(e)); }
  };
  const canEdit = !!data?.canEdit || !!gmail?.canEdit;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0"><h1 className="text-[24px] font-extrabold tracking-tight">Банкны импорт</h1><p className="text-[13.5px] text-muted">Хаан банкны орлого → утас + дүнгээр «Төлбөр хүлээж буй» захиалга «Мөнгө орсон» (дугаар солигдохгүй)</p></div>
        <div className="flex flex-wrap gap-2">
          {canEdit ? <><input ref={file} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <Button variant="primary" size="sm" loading={busy} onClick={() => file.current?.click()}>CSV импорт</Button>
            <Button size="sm" loading={busy} disabled={!gmail?.configured} onClick={() => void sync()} title={gmail?.configured ? '' : 'Gmail холбогдоогүй — «Gmail тохиргоо»'}>Gmail sync</Button>
            <Button size="sm" onClick={() => setGset(true)}>Gmail тохиргоо</Button></> : null}
          <a href={`/api/bank/export?${qs()}`} className="inline-flex h-9 items-center rounded-[11px] border border-line bg-surface px-3 text-[13px] font-semibold hover:bg-surface2">CSV экспорт</a>
        </div>
      </div>
      {gmail ? <p className="text-[12.5px] text-subtle">{gmail.configured ? `Gmail ${gmail.settings.email}${gmail.settings.autoSync ? ` · автомат ${gmail.settings.minutes} мин тутам` : ' · автомат унтраалттай'}${gmail.settings.lastSyncAt ? ` · сүүлд ${ubDateTime(gmail.settings.lastSyncAt)}: ${gmail.settings.lastResult ?? ''}` : ''}` : 'Gmail холбогдоогүй — «Gmail тохиргоо» дээр хаяг, 16 оронтой App Password бичээд холбоно (эсвэл CSV-ээр импортлоно)'}</p> : null}
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
        <div className="flex max-w-full gap-1.5 overflow-x-auto pb-1">{TABS.map(([k, l]) => <button key={k} onClick={() => { setTab(k); setPage(1); }} className={clsx('h-9 shrink-0 rounded-full border px-3 text-[13px] font-bold', tab === k ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-muted')}>{l}</button>)}</div>
        {tab !== 'changes' ? <div className="ml-auto flex flex-wrap gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Утга, утас, дүн" className="h-9 w-[180px] rounded-[10px] border border-line bg-surface px-2 text-[13.5px]" aria-label="Хайх" />
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="h-9 rounded-[10px] border border-line bg-surface px-2 text-[13px]" aria-label="Эхлэх огноо" />
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="h-9 rounded-[10px] border border-line bg-surface px-2 text-[13px]" aria-label="Дуусах огноо" />
        </div> : null}
      </div>

      {tab === 'changes' ? (
        <div className="overflow-hidden rounded-[16px] border border-line bg-surface shadow-card">
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-[13px]">
            <thead className="bg-surface2 text-[12px] text-muted"><tr><th className="px-3 py-2 text-left">Захиалга</th><th className="px-3 py-2 text-left">Утас</th><th className="px-3 py-2 text-right">Одоогийн дүн</th><th className="px-3 py-2 text-right">Төлсөн</th><th className="px-3 py-2 text-right">Зөрүү</th><th className="px-3 py-2 text-left">Төлөв</th><th className="px-3 py-2 text-left">Оператор</th></tr></thead>
            <tbody className="divide-y divide-line">{changes?.items.map((c) => (
              <tr key={c.id}><td className="px-3 py-2 font-bold">{c.number}</td><td className="px-3 py-2">{c.phone}</td><td className="px-3 py-2 text-right">{money(c.total)}</td><td className="px-3 py-2 text-right">{money(c.paid)}</td>
                <td className={clsx('px-3 py-2 text-right font-bold', c.diff < 0 ? 'text-bad-ink' : 'text-info')}>{c.diff > 0 ? '+' : ''}{money(c.diff)}</td><td className="px-3 py-2">{ST_L[c.status] ?? c.status}</td><td className="max-w-[180px] px-3 py-2 [overflow-wrap:anywhere]">{c.operatorName}</td></tr>
            ))}</tbody></table></div>
          {changes && !changes.items.length ? <p className="px-4 py-10 text-center text-muted">Дүн зөрсөн захиалга алга</p> : null}
        </div>
      ) : (
        <div className="overflow-hidden rounded-[16px] border border-line bg-surface shadow-card">
          <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-[13px]">
            <thead className="bg-surface2 text-[12px] text-muted"><tr><th className="px-3 py-2 text-left">Огноо</th><th className="px-3 py-2 text-left">Гүйлгээний утга</th><th className="px-3 py-2 text-right">Дүн</th><th className="px-3 py-2 text-left">Утас</th><th className="px-3 py-2 text-left">Төлөв</th><th className="px-3 py-2 text-left">Захиалга</th><th className="px-3 py-2" /></tr></thead>
            <tbody className="divide-y divide-line">{data?.items.map((t) => (
              <tr key={t.id} className="align-top">
                <td className="px-3 py-2 whitespace-nowrap text-[12.5px]">{ubDateTime(t.txDate)}<span className="block text-[11px] text-subtle">{t.source === 'GMAIL' ? 'Gmail' : 'CSV'}</span></td>
                <td className="max-w-[320px] px-3 py-2 [overflow-wrap:anywhere]">{t.description}</td>
                <td className="px-3 py-2 text-right font-bold whitespace-nowrap">{money(t.amount)}</td>
                <td className="px-3 py-2">{t.phone ?? '—'}</td>
                <td className="px-3 py-2"><Badge tone={t.refunded ? 'accent' : TONE[t.isDuplicate ? 'DUPLICATE' : t.status] ?? 'neutral'}>{t.statusLabel}</Badge>{t.matchedByName ? <span className="block text-[11px] text-subtle">{t.matchedByName}</span> : null}</td>
                <td className="px-3 py-2">{t.order ? <><b>{t.order.number}</b><span className="block text-[11.5px] text-subtle">{money(t.order.total)} · {ST_L[t.order.status] ?? t.order.status}</span></> : '—'}</td>
                <td className="px-3 py-2 text-right">{data.canEdit ? <div className="flex justify-end gap-1.5">{t.refunded ? <span className="text-[12px] text-subtle">Буцаасан — өөрчлөхгүй</span>
                  : t.order ? <span className="text-[12px] text-subtle">Таарсан — өөрчлөхгүй</span>
                  : <><Button size="sm" onClick={() => setMatch(t)}>Гараар тааруулах</Button><Button size="sm" variant="ghost" onClick={() => void refund(t)}>Буцаасан</Button></>}</div> : null}</td>
              </tr>
            ))}</tbody></table></div>
          {data && !data.items.length ? <p className="px-4 py-10 text-center text-muted">Гүйлгээ алга</p> : null}
          {data && data.pages > 1 ? (
            <div className="flex items-center justify-between border-t border-line px-3 py-2 text-[13px]"><span className="text-muted">{data.total} гүйлгээ</span>
              <div className="flex items-center gap-2"><Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</Button><span>{page} / {data.pages}</span><Button size="sm" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>›</Button></div></div>
          ) : null}
        </div>
      )}
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
  useEffect(() => {
    const h = setTimeout(async () => { try { setItems((await api<{ items: typeof items }>(`/api/bank/orders?q=${encodeURIComponent(q)}`)).items); } catch (e) { setErr(msg(e)); } }, 250);
    return () => clearTimeout(h);
  }, [q]);
  const go = async (number: string) => {
    setBusy(true); setErr(null);
    try { const r = await api<{ paid: number; total: number; paidMarked: boolean }>(`/api/bank/${t.id}/match`, { method: 'POST', json: { orderNumber: number } }); onDone(`№${number}: төлсөн ${money(r.paid)} / ${money(r.total)}${r.paidMarked ? ' — «Мөнгө орсон» боллоо' : ''}`); }
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
            <Button size="sm" variant="primary" loading={busy} onClick={() => void go(o.number)}>Холбох</Button>
          </div>
        ))}
        {!items.length ? <p className="px-3 py-4 text-center text-[13px] text-muted">Захиалга олдсонгүй</p> : null}
      </div>
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
