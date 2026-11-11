'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { ReasonModal } from '@/components/ui/ReasonModal';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';
import { formatPhone } from '@/lib/phone';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const card = 'rounded-[16px] border border-line bg-surface p-3 shadow-card';

// ───────────────────────── Хар жагсаалт ─────────────────────────

interface BEntry { id: number; phone: string; reason: string; orderNumber: string | null; reportedBy: string; createdAt: string }
export function BlacklistClient() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; pageSize: number; canManage: boolean; items: BEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [add, setAdd] = useState(false);
  const [form, setForm] = useState({ phone: '', reason: '', orderNumber: '' });
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<BEntry | null>(null);
  const load = useCallback(() => api<NonNullable<typeof data>>(`/api/orders/blacklist?q=${encodeURIComponent(q)}&page=${page}`).then(setData).catch((e) => setError(msg(e))), [q, page]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <input type="search" inputMode="numeric" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Утсаар хайх" className="h-11 min-w-[200px] flex-1 rounded-xl border border-line bg-surface px-3.5 outline-none focus:border-accent" />
        {data?.canManage ? <Button variant="primary" onClick={() => { setForm({ phone: '', reason: '', orderNumber: '' }); setAdd(true); }}>Дугаар нэмэх</Button> : null}
      </div>
      <p className="text-[13px] text-subtle">Хар жагсаалтын дугаараар захиалга үүсгэхэд анхааруулга гарна, оператор шалтгаан бичиж үргэлжлүүлнэ.{data && !data.canManage ? ' Жагсаалтыг ахлах оператор удирдана.' : ''}</p>
      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}
      {!data ? <p className="text-muted">Ачаалж байна…</p> : !data.items.length ? <p className="rounded-xl bg-surface2 p-6 text-center text-muted">Хоосон</p> : (
        <ul className="flex flex-col gap-2">
          {data.items.map((b) => (
            <li key={b.id} className={clsx(card, 'flex flex-wrap items-center gap-3')}>
              <span className="flex min-w-[200px] flex-1 flex-col">
                <span className="select-text text-[16px] font-extrabold">{formatPhone(b.phone)}</span>
                <span className="text-[14px] [overflow-wrap:anywhere]">{b.reason}</span>
                <span className="text-[12px] text-subtle">{b.reportedBy} · {ubDateTime(b.createdAt)}{b.orderNumber ? ` · №${b.orderNumber}` : ''}</span>
              </span>
              {data.canManage ? <Button size="sm" variant="danger" onClick={() => setRemoving(b)}>Хасах</Button> : null}
            </li>
          ))}
        </ul>
      )}
      {data && data.total > data.pageSize ? <Pager page={page} hasMore={page * data.pageSize < data.total} onPage={setPage} /> : null}
      <Modal open={add} onClose={() => setAdd(false)} title="Хар жагсаалтад нэмэх"
        footer={<><Button onClick={() => setAdd(false)}>Болих</Button><Button variant="danger" loading={busy}
          onClick={async () => { setBusy(true); setError(null); try { await api('/api/orders/blacklist', { method: 'POST', json: form }); setAdd(false); setFlash('Нэмлээ'); load(); } catch (e) { setError(msg(e)); } finally { setBusy(false); } }}>Нэмэх</Button></>}>
        <div className="flex flex-col gap-3">
          {error ? <Notice>{error}</Notice> : null}
          <Field id="bphone" label="Утас" inputMode="numeric" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <Field id="breason" label="Шалтгаан (5+ тэмдэгт)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          <Field id="border" label="Захиалгын № (заавал биш)" value={form.orderNumber} onChange={(e) => setForm({ ...form, orderNumber: e.target.value })} />
        </div>
      </Modal>
      <ReasonModal open={!!removing} title={removing ? `${formatPhone(removing.phone)} хасах` : ''} label="Яагаад хасаж байна?" confirmText="Хасах" busy={busy} onCancel={() => setRemoving(null)}
        onConfirm={async (note) => { if (!removing) return; setBusy(true); try { await api(`/api/orders/blacklist/${removing.id}`, { method: 'DELETE', json: { note } }); setRemoving(null); setFlash('Хаслаа'); load(); } catch (e) { setError(msg(e)); } finally { setBusy(false); } }} />
    </div>
  );
}

function Pager({ page, hasMore, onPage }: { page: number; hasMore: boolean; onPage: (p: number) => void }) {
  return (
    <div className="flex items-center justify-center gap-3">
      <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Өмнөх</Button>
      <span className="text-[13px] text-muted">{page}-р хуудас</span>
      <Button size="sm" disabled={!hasMore} onClick={() => onPage(page + 1)}>Дараах</Button>
    </div>
  );
}

// ───────────────────────── Хөнгөлөлт шалгах (Супер админ) ─────────────────────────

interface RItem {
  id: string; at: string; actorName: string; action: string; orderId: number; review: { by: string; at: string } | null;
  details: { number?: string; discount?: number; total?: number; feeReason?: string; defaultFee?: number; deliveryFee?: number; lines?: { code: string; qty: number; unitPrice: number; listPrice: number; discountReason: string | null }[]; changes?: Record<string, { from: unknown; to: unknown }> } | null;
}
export function DiscountReviewClient() {
  const [only, setOnly] = useState(true);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: RItem[]; hasMore: boolean; unreviewed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => api<NonNullable<typeof data>>(`/api/orders/review?unreviewed=${only ? 1 : 0}&page=${page}`).then(setData).catch((e) => setError(msg(e))), [only, page]);
  useEffect(() => { load(); }, [load]);
  async function review(ids: string[] | 'all', key: string) {
    setBusy(key); setError(null);
    try { await api('/api/orders/review', { method: 'POST', json: { ids } }); await load(); } catch (e) { setError(msg(e)); } finally { setBusy(null); }
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-2 text-[14px] font-semibold"><input type="checkbox" className="h-5 w-5" checked={only} onChange={(e) => { setOnly(e.target.checked); setPage(1); }} />Зөвхөн шалгаагүй</label>
        {data ? <Badge tone={data.unreviewed ? 'warn' : 'ok'}>{data.unreviewed} шалгаагүй</Badge> : null}
        {data?.unreviewed ? <Button className="ml-auto" variant="dark" loading={busy === 'all'} onClick={() => review('all', 'all')}>Бүгдийг шалгасан</Button> : null}
      </div>
      {error ? <Notice>{error}</Notice> : null}
      {!data ? <p className="text-muted">Ачаалж байна…</p> : !data.items.length ? <p className="rounded-xl bg-surface2 p-6 text-center text-muted">Шалгах зүйл алга</p> : (
        <ul className="flex flex-col gap-2">
          {data.items.map((r) => {
            const d = r.details ?? {};
            const disc = (d.lines ?? []).filter((l) => l.unitPrice < l.listPrice);
            return (
              <li key={r.id} className={clsx(card, 'flex flex-wrap items-start gap-3')}>
                <span className="flex min-w-[220px] flex-1 flex-col gap-1 text-[14px]">
                  <span className="flex flex-wrap items-center gap-2"><Link href={`/orders/${r.orderId}`} className="font-extrabold underline">№{d.number ?? r.orderId}</Link><span className="text-subtle">{r.action === 'order.created' ? 'үүсгэхэд' : 'засахад'}</span>{d.discount ? <Badge tone="warn">−{money(d.discount)}</Badge> : null}</span>
                  {disc.map((l) => <span key={l.code}>{l.code}: {money(l.listPrice)} → <b>{money(l.unitPrice)}</b> × {l.qty} — <i>{l.discountReason}</i></span>)}
                  {r.action === 'order.updated' && d.changes?.total ? <span>Дүн: {money(Number(d.changes.total.from))} → <b>{money(Number(d.changes.total.to))}</b></span> : null}
                  {d.feeReason ? <span className="text-warn">Хүргэлт {d.defaultFee !== undefined ? `${money(d.defaultFee)} → ` : ''}{d.deliveryFee !== undefined ? money(d.deliveryFee) : ''}: {d.feeReason}</span> : null}
                  <span className="text-[12px] text-subtle">{r.actorName} · {ubDateTime(r.at)}</span>
                </span>
                {r.review ? <Badge tone="ok">✓ {r.review.by}</Badge> : <Button size="sm" variant="dark" loading={busy === r.id} onClick={() => review([r.id], r.id)}>Шалгасан</Button>}
              </li>
            );
          })}
        </ul>
      )}
      {data && (page > 1 || data.hasMore) ? <Pager page={page} hasMore={data.hasMore} onPage={setPage} /> : null}
    </div>
  );
}

// ───────────────────────── Пэйж хуваарилалт (ахлах оператор) ─────────────────────────

export function PageAssignClient() {
  const [ops, setOps] = useState<{ id: string; name: string; phone: string; pageIds: number[] }[] | null>(null);
  const [pages, setPages] = useState<{ id: number; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([api<{ items: NonNullable<typeof ops> }>('/api/orders/assignments'), api<{ pages: { id: number; name: string }[] }>('/api/orders/pages')])
      .then(([a, p]) => { setOps(a.items); setPages(p.pages); }).catch((e) => setError(msg(e)));
  }, []);
  async function toggle(uid: string, pid: number) {
    if (!ops) return;
    const u = ops.find((o) => o.id === uid)!;
    const next = u.pageIds.includes(pid) ? u.pageIds.filter((x) => x !== pid) : [...u.pageIds, pid];
    setOps(ops.map((o) => (o.id === uid ? { ...o, pageIds: next } : o)));
    setError(null);
    try { await api('/api/orders/assignments', { method: 'POST', json: { userId: uid, pageIds: next } }); setSaved(`${u.name} — хадгаллаа`); }
    catch (e) { setError(msg(e)); setOps((cur) => cur && cur.map((o) => (o.id === uid ? u : o))); }
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] text-muted">Оператор бүрт харагдах пэйжийг сонгоно. Юу ч сонгоогүй бол бүх пэйж харагдана. Пэйжийг нэмэх, нэр солихыг «Тохиргоо» хэсэгт хийнэ.</p>
      {saved ? <Notice tone="ok">{saved}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}
      {!ops ? <p className="text-muted">Ачаалж байна…</p> : !pages.length ? <Notice tone="info">Пэйж бүртгэгдээгүй байна — Тохиргоо хэсэгт нэмнэ үү.</Notice> : (
        <ul className="flex flex-col gap-2">
          {ops.map((o) => (
            <li key={o.id} className={clsx(card, 'flex flex-col gap-2')}>
              <span className="font-bold">{o.name} <span className="text-[12px] font-normal text-subtle">{o.pageIds.length ? `${o.pageIds.length} пэйж` : 'бүх пэйж'}</span></span>
              <span className="flex flex-wrap gap-2">
                {pages.map((p) => {
                  const on = o.pageIds.includes(p.id);
                  return <button key={p.id} type="button" aria-pressed={on} onClick={() => toggle(o.id, p.id)} className={clsx('h-10 rounded-full border px-3.5 text-[13.5px] font-semibold', on ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>{p.name}</button>;
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
