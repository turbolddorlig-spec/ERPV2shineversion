'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { ReasonModal } from '@/components/ui/ReasonModal';
import { Select } from '@/components/ui/Select';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';
import { ZoomButton } from '@/components/ui/Lightbox';
import { money, ubDateTime } from '@/lib/format';
import { formatPhone } from '@/lib/phone';
import { StatusChip, type OItem } from './OrdersClient';
import { OrderModal, type EditOrder } from './OrderForm';

interface Detail extends OItem {
  version: number; status: string; subtotal: number; deliveryFeeEdited: boolean; blacklistNote: string | null; inHandover: boolean;
  paymentDeadline: string | null; confirmedAt: string | null; cancelNote: string | null; cancelledAt: string | null; cancelledByName: string | null;
  history: { id: string; at: string; actorName: string; action: string; details: Record<string, unknown> | null; tags: string[] }[];
  meta: { status: string; sentAt: string | null; attempts: number } | null;
  can: { edit: boolean; markPaid: boolean };
}
const ACTION: Record<string, string> = {
  'order.created': 'Үүсгэсэн', 'order.updated': 'Засварласан', 'order.cancelled': 'Цуцалсан', 'order.paid': 'Мөнгө орсон', 'order.paid_undone': '«Мөнгө орсон» буцаасан', 'order.deadline_extended': 'Төлбөрийн хугацаа сунгасан',
};
const FIELD: Record<string, string> = { phone: 'Утас', extraPhone: 'Нэмэлт утас', province: 'Аймаг/хот', district: 'Дүүрэг', khoroo: 'Хороо', addressDetail: 'Хаяг', note: 'Тэмдэглэл', pageId: 'Пэйж', deliveryDate: 'Хүргэх өдөр', total: 'Дүн', deliveryFee: 'Хүргэлт', lines: 'Бараа' };
const CANCEL = [{ v: 'CUSTOMER_CANCELLED', l: 'Үйлчлүүлэгч болисон' }, { v: 'DUPLICATE', l: 'Давхар захиалга' }, { v: 'OUT_OF_STOCK', l: 'Бараа дутуу' }, { v: 'NO_ANSWER', l: 'Утас авахгүй' }, { v: 'OTHER', l: 'Бусад' }];

export function OrderDetail({ id }: { id: number }) {
  const router = useRouter();
  const [o, setO] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [cnote, setCnote] = useState('');
  const [undo, setUndo] = useState(false);
  const [editing, setEditing] = useState<EditOrder | null>(null);
  const load = useCallback(() => api<{ order: Detail }>(`/api/orders/${id}`).then((r) => setO(r.order)), [id]);
  useEffect(() => {
    const d = new URLSearchParams(window.location.search).get('done');
    if (d) setFlash(d);
    load().catch((e) => setError(e instanceof ApiError ? e.message : 'Ачаалж чадсангүй'));
  }, [load]);

  async function act(path: string, json: unknown, ok: string) {
    setError(null); setBusy(true);
    try { await api(`/api/orders/${id}/${path}`, { method: 'POST', json }); setFlash(ok); await load(); router.refresh(); return true; }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Алдаа'); return false; } finally { setBusy(false); }
  }

  if (!o) return error ? <Notice>{error}</Notice> : <p className="text-muted">Ачаалж байна…</p>;
  const active = ['PENDING_PAYMENT', 'NEW', 'ASSIGNED'].includes(o.status);
  const sec = 'flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card';
  return (
    <div className="grid gap-4 pb-24 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        {flash ? <Notice tone="ok">{flash}</Notice> : null}
        {error ? <Notice>{error}</Notice> : null}
        <section className={sec}>
          <div className="flex flex-wrap items-center gap-2"><StatusChip o={o} />{o.meta ? <span className="text-[12px] text-subtle">Meta: {o.meta.status === 'SENT' ? 'илгээсэн' : o.meta.status === 'SKIPPED' ? 'алгассан' : o.meta.status === 'FAILED' ? `алдаатай (${o.meta.attempts})` : 'дараалалд'}</span> : null}</div>
          <div className="grid gap-2 text-[14.5px] sm:grid-cols-2">
            <p className="select-text"><span className="text-muted">Утас: </span><a href={`tel:${o.phone}`} className="font-bold">{formatPhone(o.phone)}</a>{o.extraPhone ? <> · <a href={`tel:${o.extraPhone}`} className="font-bold">{formatPhone(o.extraPhone)}</a></> : null}</p>
            <p><span className="text-muted">Хүргэх өдөр: </span><span className="font-bold">{o.deliveryDate}</span></p>
            <p className="select-text sm:col-span-2"><span className="text-muted">📍 </span>{o.fullAddress}</p>
            {o.note ? <p className="sm:col-span-2"><span className="text-muted">Тэмдэглэл: </span>{o.note}</p> : null}
            <p><span className="text-muted">Оператор: </span>{o.operatorName}{o.pageName ? ` · ${o.pageName}` : ''}</p>
            <p><span className="text-muted">Үүссэн: </span>{ubDateTime(o.createdAt)}{o.confirmedAt ? ` · баталгаажсан ${ubDateTime(o.confirmedAt)}` : ''}</p>
            {o.paymentDeadline && o.status === 'PENDING_PAYMENT' ? <p className="text-warn sm:col-span-2">Төлбөрийн хугацаа: {ubDateTime(o.paymentDeadline)} хүртэл (дараа нь автоматаар цуцлагдана)</p> : null}
            {o.blacklistNote ? <p className="text-bad-ink sm:col-span-2">⚠️ Хар жагсаалттай — шалтгаан: {o.blacklistNote}</p> : null}
            {o.status === 'CANCELLED' ? <p className="text-bad-ink sm:col-span-2">Цуцалсан: {o.cancelLabel} — {o.cancelNote} ({o.cancelledByName}, {ubDateTime(o.cancelledAt)})</p> : null}
          </div>
        </section>
        <section className={sec}>
          <h2 className="text-[16px] font-extrabold">Бараа</h2>
          <ul className="flex flex-col divide-y divide-line">
            {o.lines.map((l, i) => (
              <li key={l.id} className="flex flex-wrap items-center gap-3 py-2.5">
                {l.thumb ? <ZoomButton images={o.lines.filter((x) => x.image).map((x) => ({ src: x.image!, alt: `${x.name} ${x.label}`, name: x.code }))} index={o.lines.filter((x) => x.image).findIndex((x) => x.id === l.id)} label={`${l.name} — томруулах`}><Thumb src={l.thumb} alt={l.name} size={60} /></ZoomButton> : <Thumb src={null} alt={l.name} size={60} />}
                <span className="flex min-w-[160px] flex-1 flex-col">
                  <span className="text-[15px] font-bold">{l.name}{l.label ? <span className="text-muted"> · {l.label}</span> : null}</span>
                  <span className="text-[12px] text-subtle">{l.code}</span>
                  {l.unitPrice < l.listPrice ? <span className="text-[12px] text-warn">Хямдруулсан {money(l.listPrice)} → {money(l.unitPrice)}: {l.discountReason}</span> : null}
                </span>
                <span className="text-[14px]">{money(l.unitPrice)} × {l.qty}</span>
                <span className="w-24 text-right text-[15px] font-extrabold">{money(l.unitPrice * l.qty)}</span>
                <span className="sr-only">{i}</span>
              </li>
            ))}
          </ul>
          <dl className="ml-auto flex w-full max-w-[300px] flex-col gap-1 text-[14px]">
            <div className="flex justify-between"><dt className="text-muted">Бараа</dt><dd>{money(o.subtotal)}</dd></div>
            {o.discount ? <div className="flex justify-between text-warn"><dt>Хөнгөлөлт</dt><dd>−{money(o.discount)}</dd></div> : null}
            <div className="flex justify-between"><dt className="text-muted">Хүргэлт{o.deliveryFeeEdited ? ' (өөрчилсөн)' : ''}</dt><dd>{money(o.deliveryFee)}</dd></div>
            <div className="flex justify-between border-t border-line pt-1 text-[17px] font-extrabold"><dt>Төлөх</dt><dd>{money(o.total)}</dd></div>
          </dl>
        </section>
      </div>
      <aside className="flex flex-col gap-4">
        <section className={sec}>
          <h2 className="text-[16px] font-extrabold">Түүх</h2>
          <ol className="flex flex-col gap-2.5 text-[13px]">
            {o.history.map((h) => {
              const d = h.details ?? {};
              const ch = (d.changes ?? {}) as Record<string, { from: unknown; to: unknown }>;
              return (
                <li key={h.id} className="border-l-2 border-line pl-3">
                  <p className="font-bold">{ACTION[h.action] ?? h.action}{h.tags.includes('discount') ? <span className="ml-1 text-warn">· хөнгөлөлт</span> : null}</p>
                  <p className="text-subtle">{h.actorName} · {ubDateTime(h.at)}</p>
                  {Object.entries(ch).map(([k, v]) => <p key={k} className="text-muted">{FIELD[k] ?? k}: {k === 'lines' ? (v.to as string[]).join('; ') : `${String(v.from ?? '—')} → ${String(v.to ?? '—')}`}</p>)}
                  {typeof d.note === 'string' ? <p className="text-muted">{d.note}</p> : null}
                  {typeof d.feeReason === 'string' ? <p className="text-warn">Хүргэлт: {d.feeReason}</p> : null}
                </li>
              );
            })}
          </ol>
        </section>
      </aside>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:left-[84px]">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-end gap-2">
          <Link href="/orders" className="mr-auto inline-flex h-11 items-center gap-1 rounded-[11px] border border-line bg-surface px-4 font-semibold"><Icon name="left" size={16} />Жагсаалт</Link>
          {o.can.markPaid && o.status === 'PENDING_PAYMENT' ? <Button variant="dark" loading={busy} onClick={() => act('paid', {}, 'Мөнгө орсон — захиалга «Шинэ» боллоо')}>Мөнгө орсон</Button> : null}
          {o.can.markPaid && o.status === 'PENDING_PAYMENT' ? <Button loading={busy} onClick={() => act('extend', { days: 3 }, 'Хугацааг 3 хоногоор сунгалаа')}>+3 хоног</Button> : null}
          {o.can.markPaid && o.status === 'NEW' && o.prepaid ? <Button onClick={() => setUndo(true)}>«Мөнгө орсон» буцаах</Button> : null}
          {o.can.edit && active ? <Button variant="danger" onClick={() => { setReason(''); setCnote(''); setCancelOpen(true); }}>Цуцлах</Button> : null}
          {o.can.edit && active ? <Button variant="primary" onClick={() => api<{ order: EditOrder }>(`/api/orders/${o.id}`).then((r) => setEditing(r.order)).catch((e) => setError(e instanceof ApiError ? e.message : 'Алдаа'))}><Icon name="edit" size={16} />Засах</Button> : null}
        </div>
      </div>
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title={`№${o.number} цуцлах`}
        footer={<><Button onClick={() => setCancelOpen(false)}>Болих</Button><Button variant="danger" loading={busy} disabled={!reason || cnote.replace(/\s/g, '').length < 5}
          onClick={async () => { if (await act('cancel', { reason, note: cnote, version: o.version }, 'Захиалга цуцлагдлаа — нөөц суллагдсан')) setCancelOpen(false); }}>Цуцлах</Button></>}>
        <div className="flex flex-col gap-3">
          <Select id="creason" label="Шалтгаан" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">— Сонгох —</option>
            {CANCEL.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}
          </Select>
          <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-muted">Тайлбар (5+ тэмдэгт)
            <textarea rows={3} value={cnote} onChange={(e) => setCnote(e.target.value)} className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-ink outline-none focus:border-accent" />
          </label>
        </div>
      </Modal>
      <OrderModal open={!!editing} edit={editing} onClose={() => setEditing(null)}
        onDone={(m) => { setEditing(null); setFlash(m); load(); router.refresh(); }}
        onAddToExisting={() => undefined} />
      <ReasonModal open={undo} title="«Мөнгө орсон» буцаах" label="Шалтгаан" confirmText="Буцаах" busy={busy} onCancel={() => setUndo(false)}
        onConfirm={async (note) => { if (await act('unpaid', { note }, 'Буцаалаа — «Төлбөр хүлээж буй»')) setUndo(false); }} />
    </div>
  );
}
