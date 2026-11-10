'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';
import { ubDateTime } from '@/lib/format';
import { formatPhone } from '@/lib/phone';

interface Note {
  id: number; phone: string; note: string | null; status: string; statusLabel: string; ownerId: string; ownerName: string; attempts: number;
  lastAttemptAt: string | null; canAttemptAt: string | null; variantId: number | null; product: string | null; productCode: string | null; thumb: string | null;
  pageId: number | null; pageName: string | null; orderId: number | null; closeLabel: string | null; closeNote: string | null; createdAt: string;
}
interface Resp { total: number; page: number; pageSize: number; supervise: boolean; items: Note[]; incoming: { transferId: number; fromName: string; createdAt: string; note: Note }[] }
interface Hit { variantId: number; variantCode: string; fullName: string; thumb: string | null; available: number }

const TABS = [{ v: 'open', l: 'Нээлттэй' }, { v: 'ORDERED', l: 'Захиалсан' }, { v: 'CANCELLED', l: 'Хаасан' }, { v: 'all', l: 'Бүгд' }];
const CLOSE = [
  { v: 'NO_ANSWER', l: 'Утсаа аваагүй' }, { v: 'PRICE', l: 'Үнэ үнэтэй' }, { v: 'OUT_OF_STOCK', l: 'Бараа дууссан' }, { v: 'NO_SIZE_COLOR', l: 'Өнгө, хэмжээ байхгүй' },
  { v: 'DELIVERY', l: 'Хүргэлт' }, { v: 'JUST_ASKING', l: 'Зүгээр асуусан' }, { v: 'BOUGHT_ELSEWHERE', l: 'Өөр газраас авсан' }, { v: 'OTHER', l: 'Бусад' },
];
const chip = (on: boolean) => clsx('inline-flex h-10 shrink-0 items-center rounded-full border px-3.5 text-[13.5px] font-semibold', on ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-ink');

export function CallsClient() {
  const [tab, setTab] = useState('open');
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Resp | null>(null);
  const [ops, setOps] = useState<{ id: string; name: string }[]>([]);
  const [pages, setPages] = useState<{ id: number; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [closing, setClosing] = useState<Note | null>(null);
  const [transfer, setTransfer] = useState<Note | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [moveTo, setMoveTo] = useState('');
  const req = useRef(0);

  const load = useCallback(() => {
    const id = ++req.current;
    const sp = new URLSearchParams({ status: tab, page: String(page) });
    if (q.trim()) sp.set('q', q.trim());
    if (owner) sp.set('ownerId', owner);
    return api<Resp>(`/api/calls?${sp}`).then((r) => { if (id === req.current) setData(r); }).catch((e) => setError(e instanceof ApiError ? e.message : 'Ачаалж чадсангүй'));
  }, [tab, page, q, owner]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => {
    api<{ items: { id: string; name: string }[] }>('/api/calls/operators').then((r) => setOps(r.items)).catch(() => undefined);
    api<{ pages: { id: number; name: string }[] }>('/api/orders/pages').then((r) => setPages(r.pages)).catch(() => undefined);
  }, []);
  // 30 минутын хаалтыг дэлгэцэн дээр шинэчлэх
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);

  async function run(id: number, fn: () => Promise<unknown>, ok: string) {
    setError(null); setBusy(id);
    try { await fn(); setFlash(ok); await load(); return true; } catch (e) { setError(e instanceof ApiError ? e.message : 'Алдаа'); return false; } finally { setBusy(null); }
  }

  const items = data?.items ?? [];
  const sup = !!data?.supervise;
  return (
    <div className="flex flex-col gap-4">
      {data?.incoming.length ? (
        <section className="flex flex-col gap-2 rounded-[18px] border border-accent bg-accent-soft p-4">
          <h2 className="text-[15px] font-extrabold text-accent-ink">Танд шилжүүлэх хүсэлт ({data.incoming.length})</h2>
          {data.incoming.map((t) => (
            <div key={t.transferId} className="flex flex-wrap items-center gap-2 rounded-xl bg-surface p-3">
              <span className="flex-1 text-[14px]"><b>{formatPhone(t.note.phone)}</b> · {t.note.product ?? '—'} <span className="text-subtle">— {t.fromName}-аас</span></span>
              <Button size="sm" variant="dark" loading={busy === -t.transferId} onClick={() => run(-t.transferId, () => api(`/api/calls/transfers/${t.transferId}`, { method: 'POST', json: { accept: true } }), 'Хүлээн авлаа')}>Хүлээн авах</Button>
              <Button size="sm" onClick={() => run(-t.transferId, () => api(`/api/calls/transfers/${t.transferId}`, { method: 'POST', json: { accept: false } }), 'Татгалзлаа')}>Татгалзах</Button>
            </div>
          ))}
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {TABS.map((t) => <button key={t.v} type="button" aria-pressed={tab === t.v} className={chip(tab === t.v)} onClick={() => { setTab(t.v); setPage(1); setSel(new Set()); }}>{t.l}</button>)}
        </div>
        <Button variant="primary" className="ml-auto" onClick={() => setAddOpen(true)}><Icon name="plus" size={16} />Дугаар нэмэх</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <input type="search" inputMode="numeric" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Утасны дугаараар хайх"
          className="h-11 min-w-[220px] flex-1 rounded-xl border border-line bg-surface px-3.5 outline-none focus:border-accent" />
        {sup ? (
          <select aria-label="Оператор" value={owner} onChange={(e) => { setOwner(e.target.value); setPage(1); }} className="h-11 rounded-xl border border-line bg-surface px-3">
            <option value="">Бүх оператор</option>
            {ops.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        ) : null}
      </div>
      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}

      {sup && sel.size ? (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3 shadow-card">
          <span className="font-bold">{sel.size} сонгосон</span>
          <select aria-label="Шилжүүлэх оператор" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="h-10 rounded-xl border border-line bg-surface px-3">
            <option value="">— Оператор —</option>
            {ops.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <Button size="sm" variant="dark" disabled={!moveTo} loading={busy === 0}
            onClick={async () => { if (await run(0, () => api('/api/calls/reassign', { method: 'POST', json: { ids: [...sel], toUserId: moveTo } }), 'Шилжүүллээ')) setSel(new Set()); }}>Шууд шилжүүлэх</Button>
          <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Болих</Button>
        </div>
      ) : null}

      {!data ? <p className="text-muted">Ачаалж байна…</p> : !items.length ? <p className="rounded-xl bg-surface2 p-6 text-center text-muted">Тэмдэглэл алга</p> : (
        <ul className="flex flex-col gap-2">
          {items.map((n) => {
            const open = ['PENDING', 'CONTACTED'].includes(n.status);
            const wait = n.canAttemptAt ? Math.max(0, Math.ceil((new Date(n.canAttemptAt).getTime() - Date.now()) / 60000)) : 0;
            const orderHref = `/orders/new?${new URLSearchParams({ phone: n.phone, ...(n.variantId ? { variantId: String(n.variantId), code: n.productCode ?? '' } : {}), ...(n.pageId ? { pageId: String(n.pageId) } : {}) })}`;
            return (
              <li key={n.id} className="flex flex-wrap items-center gap-3 rounded-[16px] border border-line bg-surface p-3 shadow-card">
                {sup && open ? <input type="checkbox" aria-label="Сонгох" className="h-5 w-5" checked={sel.has(n.id)} onChange={(e) => setSel((s) => { const x = new Set(s); if (e.target.checked) x.add(n.id); else x.delete(n.id); return x; })} /> : null}
                <Thumb src={n.thumb} alt={n.product ?? ''} size={48} />
                <span className="flex min-w-[180px] flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <a href={`tel:${n.phone}`} className="select-text text-[16px] font-extrabold">{formatPhone(n.phone)}</a>
                    <Badge tone={n.status === 'ORDERED' ? 'ok' : n.status === 'CANCELLED' ? 'bad' : n.status === 'CONTACTED' ? 'info' : 'neutral'}>{n.statusLabel}</Badge>
                    {open ? <span className="text-[12px] text-subtle">{n.attempts}/5 оролдлого</span> : null}
                  </span>
                  <span className="text-[13.5px]">{n.product ?? <span className="text-subtle">Бараа заагаагүй</span>}{n.pageName ? <span className="text-subtle"> · {n.pageName}</span> : null}</span>
                  {n.note ? <span className="text-[13px] text-muted">{n.note}</span> : null}
                  {n.closeLabel ? <span className="text-[12.5px] text-bad-ink">Шалтгаан: {n.closeLabel}{n.closeNote ? ` — ${n.closeNote}` : ''}</span> : null}
                  <span className="text-[12px] text-subtle">{sup ? `${n.ownerName} · ` : ''}{ubDateTime(n.createdAt)}{n.lastAttemptAt ? ` · сүүлд залгасан ${ubDateTime(n.lastAttemptAt)}` : ''}</span>
                </span>
                <span className="flex flex-wrap gap-2">
                  {n.orderId ? <Link href={`/orders/${n.orderId}`} className="inline-flex h-10 items-center rounded-[11px] border border-line px-3 text-[13.5px] font-semibold">Захиалга харах</Link> : null}
                  {open ? <>
                    <Button size="sm" disabled={wait > 0 || n.attempts >= 5} loading={busy === n.id} onClick={() => run(n.id, () => api(`/api/calls/${n.id}/attempt`, { method: 'POST', json: {} }), 'Оролдлого бүртгэлээ')}>
                      <Icon name="phone" size={15} />{wait > 0 ? `${wait} мин` : 'Залгасан'}
                    </Button>
                    <Link href={orderHref} className="inline-flex h-10 items-center rounded-[11px] bg-accent px-3 text-[13.5px] font-bold text-on-accent">Захиалга болгох</Link>
                    <Button size="sm" variant="ghost" onClick={() => setTransfer(n)}>Шилжүүлэх</Button>
                    <Button size="sm" variant="danger" onClick={() => setClosing(n)}>Хаах</Button>
                  </> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {data && data.total > data.pageSize ? (
        <div className="flex items-center justify-center gap-3">
          <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Өмнөх</Button>
          <span className="text-[13px] text-muted">{page} / {Math.ceil(data.total / data.pageSize)}</span>
          <Button size="sm" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Дараах</Button>
        </div>
      ) : null}

      <AddModal open={addOpen} pages={pages} onClose={() => setAddOpen(false)} onDone={(c) => { setAddOpen(false); setFlash(`${c} дугаар нэмлээ`); setTab('open'); load(); }} />
      <CloseModal note={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); setFlash('Тэмдэглэл хаагдлаа'); load(); }} />
      <Modal open={!!transfer} onClose={() => setTransfer(null)} title="Өөр операторт шилжүүлэх"
        footer={<><Button onClick={() => setTransfer(null)}>Болих</Button><Button variant="dark" disabled={!moveTo} loading={busy === transfer?.id}
          onClick={async () => { if (transfer && await run(transfer.id, () => api(`/api/calls/${transfer.id}/transfer`, { method: 'POST', json: { toUserId: moveTo } }), 'Хүсэлт илгээлээ — нөгөө оператор хүлээн авна')) setTransfer(null); }}>Хүсэлт илгээх</Button></>}>
        <Select id="tto" label="Оператор" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
          <option value="">— Сонгох —</option>
          {ops.filter((o) => o.id !== transfer?.ownerId).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </Select>
      </Modal>
    </div>
  );
}

function AddModal({ open, pages, onClose, onDone }: { open: boolean; pages: { id: number; name: string }[]; onClose: () => void; onDone: (n: number) => void }) {
  const [phones, setPhones] = useState('');
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [hit, setHit] = useState<Hit | null>(null);
  const [pageId, setPageId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setPhones(''); setTerm(''); setHit(null); setNote(''); setError(null); } }, [open]);
  useEffect(() => {
    if (term.trim().length < 2 || hit) { setHits([]); return; }
    const t = setTimeout(() => api<{ items: Hit[] }>(`/api/products/search?q=${encodeURIComponent(term)}&limit=8`).then((r) => setHits(r.items)).catch(() => undefined), 220);
    return () => clearTimeout(t);
  }, [term, hit]);
  const count = [...new Set(phones.replace(/[^\d\s,;]/g, ' ').split(/[\s,;]+/).filter((p) => p.length >= 8))].length;
  return (
    <Modal open={open} onClose={onClose} title="Дугаар нэмэх"
      footer={<><Button onClick={onClose}>Болих</Button><Button variant="primary" loading={busy} disabled={!count}
        onClick={async () => {
          setBusy(true); setError(null);
          try { const r = await api<{ created: number }>('/api/calls', { method: 'POST', json: { phones, variantId: hit?.variantId, productText: hit ? undefined : term, pageId: pageId || undefined, note } }); onDone(r.created); }
          catch (e) { setError(e instanceof ApiError ? e.message : 'Алдаа'); } finally { setBusy(false); }
        }}>{count ? `${count} дугаар нэмэх` : 'Нэмэх'}</Button></>}>
      <div className="flex flex-col gap-3">
        {error ? <Notice>{error}</Notice> : null}
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-muted">Утас (олныг зэрэг — мөр, зай, таслалаар)
          <textarea rows={3} value={phones} onChange={(e) => setPhones(e.target.value)} inputMode="numeric" className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-ink outline-none focus:border-accent" />
        </label>
        <div className="relative flex flex-col gap-1.5">
          <label htmlFor="cprod" className="text-[13px] font-semibold text-muted">Сонирхсон бараа (заавал биш)</label>
          {hit ? (
            <div className="flex items-center gap-2 rounded-xl border border-line p-2"><Thumb src={hit.thumb} alt="" size={36} /><span className="flex-1 text-[14px]">{hit.fullName}</span><Button size="sm" variant="ghost" onClick={() => { setHit(null); setTerm(''); }}>Солих</Button></div>
          ) : <input id="cprod" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Код эсвэл нэр" className="h-11 rounded-xl border border-line bg-surface px-3.5 outline-none focus:border-accent" />}
          {hits.length ? (
            <ul className="absolute top-full z-10 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-line bg-surface shadow-card">
              {hits.map((h) => <li key={h.variantId}><button type="button" onClick={() => setHit(h)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface2"><Thumb src={h.thumb} alt="" size={32} /><span className="flex-1 text-[14px]">{h.fullName}</span><span className="text-[12px] text-subtle">{h.available} үлд.</span></button></li>)}
            </ul>
          ) : null}
        </div>
        <Select id="cpage" label="Пэйж" value={pageId} onChange={(e) => setPageId(e.target.value)}>
          <option value="">—</option>
          {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-muted">Тэмдэглэл
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="h-11 rounded-xl border border-line bg-surface px-3.5 text-ink outline-none focus:border-accent" />
        </label>
      </div>
    </Modal>
  );
}

/** Хаах (#54): систем шалтгааныг урьдчилан сонгоно, өөр бол гараар солино */
function CloseModal({ note, onClose, onDone }: { note: Note | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [text, setText] = useState('');
  const [suggested, setSuggested] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    setReason(''); setText(''); setError(null); setSuggested(null);
    api<{ reason: string | null }>(`/api/calls/${note.id}/suggest`).then((r) => { setSuggested(r.reason); if (r.reason) setReason(r.reason); }).catch(() => undefined);
  }, [note]);
  return (
    <Modal open={!!note} onClose={onClose} title={note ? `${formatPhone(note.phone)} — хаах` : ''}
      footer={<><Button onClick={onClose}>Болих</Button><Button variant="danger" loading={busy} disabled={!reason || (reason === 'OTHER' && text.trim().length < 3)}
        onClick={async () => {
          if (!note) return;
          setBusy(true); setError(null);
          try { await api(`/api/calls/${note.id}/close`, { method: 'POST', json: { reason, note: text } }); onDone(); }
          catch (e) { setError(e instanceof ApiError ? e.message : 'Алдаа'); } finally { setBusy(false); }
        }}>Хаах</Button></>}>
      <div className="flex flex-col gap-3">
        {error ? <Notice>{error}</Notice> : null}
        <p className="text-[13.5px] text-muted">Яагаад захиалга болсонгүй вэ?{suggested ? ' Систем урьдчилан сонгосон — өөр бол солино уу.' : ''}</p>
        <div className="grid grid-cols-2 gap-2">
          {CLOSE.map((c) => (
            <button key={c.v} type="button" aria-pressed={reason === c.v} onClick={() => setReason(c.v)}
              className={clsx('min-h-11 rounded-xl border px-3 py-2 text-left text-[14px] font-semibold', reason === c.v ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>
              {c.l}{suggested === c.v ? <span className="block text-[11px] font-normal opacity-75">систем санал болгосон</span> : null}
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-muted">{reason === 'OTHER' ? 'Шалтгаанаа бичнэ үү' : 'Нэмэлт тайлбар (заавал биш)'}
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} className="h-11 rounded-xl border border-line bg-surface px-3.5 text-ink outline-none focus:border-accent" />
        </label>
      </div>
    </Modal>
  );
}
