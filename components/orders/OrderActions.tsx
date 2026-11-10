'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';
import { money, ubDateTime } from '@/lib/format';
import { formatPhone } from '@/lib/phone';

export const ACTION_LABEL: Record<string, string> = {
  'order.created': 'Үүсгэсэн', 'order.updated': 'Засварласан', 'order.cancelled': 'Цуцалсан', 'order.paid': 'Мөнгө орсон', 'order.paid_undone': '«Мөнгө орсон» буцаасан', 'order.deadline_extended': 'Төлбөрийн хугацаа сунгасан',
};
export const FIELD_LABEL: Record<string, string> = { phone: 'Утас', extraPhone: 'Нэмэлт утас', province: 'Аймаг/хот', district: 'Дүүрэг', khoroo: 'Хороо', addressDetail: 'Хаяг', note: 'Тэмдэглэл', pageId: 'Пэйж', deliveryDate: 'Хүргэх өдөр', total: 'Дүн', deliveryFee: 'Хүргэлт', lines: 'Бараа' };
export const CANCEL_REASONS = [{ v: 'CUSTOMER_CANCELLED', l: 'Үйлчлүүлэгч болисон' }, { v: 'DUPLICATE', l: 'Давхар захиалга' }, { v: 'OUT_OF_STOCK', l: 'Бараа дутуу' }, { v: 'NO_ANSWER', l: 'Утас авахгүй' }, { v: 'OTHER', l: 'Бусад' }];
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');

export interface HistoryItem { id: string; at: string; actorName: string; action: string; details: Record<string, unknown> | null; tags: string[] }

/** Захиалгын түүх — хэн, хэзээ, юуг юу болгосон */
export function HistoryList({ items }: { items: HistoryItem[] }) {
  return (
    <ol className="flex flex-col gap-2.5 text-[13px]">
      {items.map((h) => {
        const d = h.details ?? {};
        const ch = (d.changes ?? {}) as Record<string, { from: unknown; to: unknown }>;
        return (
          <li key={h.id} className="border-l-2 border-line pl-3">
            <p className="font-bold">{ACTION_LABEL[h.action] ?? h.action}{h.tags.includes('discount') ? <span className="ml-1 text-warn">· хөнгөлөлт</span> : null}</p>
            <p className="text-subtle">{h.actorName} · {ubDateTime(h.at)}</p>
            {Object.entries(ch).map(([k, v]) => <p key={k} className="text-muted">{FIELD_LABEL[k] ?? k}: {k === 'lines' ? (v.to as string[]).join('; ') : `${String(v.from ?? '—')} → ${String(v.to ?? '—')}`}</p>)}
            {typeof d.note === 'string' ? <p className="text-muted">{d.note}</p> : null}
            {typeof d.feeReason === 'string' ? <p className="text-warn">Хүргэлт: {d.feeReason}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}

interface DrawerOrder {
  id: number; number: string; statusLabel: string; phone: string; extraPhone: string | null; fullAddress: string; note: string | null; operatorName: string; pageName: string | null;
  createdAt: string; deliveryDate: string; total: number; deliveryFee: number; cancelLabel: string | null; cancelNote: string | null;
  lines: { id: number; name: string; label: string; code: string; thumb: string | null; unitPrice: number; qty: number }[];
  history: HistoryItem[]; meta: { status: string } | null;
}

/** «Түүх» — хуучин ERP шиг баруун талаас гарах самбар */
export function HistoryDrawer({ orderId, onClose }: { orderId: number | null; onClose: () => void }) {
  const [o, setO] = useState<DrawerOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setO(null); setError(null);
    if (orderId) api<{ order: DrawerOrder }>(`/api/orders/${orderId}`).then((r) => setO(r.order)).catch((e) => setError(msg(e)));
  }, [orderId]);
  return (
    <Modal open={!!orderId} onClose={onClose} size="drawer" title={o ? `№${o.number} — түүх` : 'Түүх'} subtitle={o ? `${o.statusLabel} · ${o.operatorName}${o.pageName ? ` · ${o.pageName}` : ''}` : undefined}>
      {error ? <Notice>{error}</Notice> : !o ? <p className="py-6 text-center text-muted">Ачаалж байна…</p> : (
        <div className="flex flex-col gap-4 text-[13px]">
          <div className="flex flex-col gap-1 rounded-lg bg-surface2/70 p-3">
            <p><span className="text-muted">Утас: </span><b className="select-text">{formatPhone(o.phone)}</b>{o.extraPhone ? <> · <b className="select-text">{formatPhone(o.extraPhone)}</b></> : null}</p>
            <p className="select-text"><span className="text-muted">📍 </span>{o.fullAddress}</p>
            {o.note ? <p><span className="text-muted">Санамж: </span>{o.note}</p> : null}
            <p><span className="text-muted">Үүссэн: </span>{ubDateTime(o.createdAt)} · <span className="text-muted">Хүргэх: </span>{o.deliveryDate}</p>
            {o.cancelLabel ? <p className="text-bad-ink">Цуцалсан: {o.cancelLabel}{o.cancelNote ? ` — ${o.cancelNote}` : ''}</p> : null}
          </div>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {o.lines.map((l) => (
              <li key={l.id} className="flex items-center gap-2 p-2">
                <Thumb src={l.thumb} alt={l.name} size={32} />
                <span className="min-w-0 flex-1"><span className="line-clamp-1 font-semibold">{l.name}{l.label ? ` · ${l.label}` : ''}</span><span className="text-[11.5px] text-subtle">{l.code}</span></span>
                <span className="whitespace-nowrap">{money(l.unitPrice)} × {l.qty}</span>
              </li>
            ))}
            <li className="flex justify-between p-2 font-bold"><span>Нийт{o.deliveryFee ? ` (хүргэлт ${money(o.deliveryFee)})` : ''}</span><span>{money(o.total)}</span></li>
          </ul>
          <HistoryList items={o.history} />
        </div>
      )}
    </Modal>
  );
}

/** Цуцлах: шалтгаан + тайлбар заавал (нөөц суллагдана) */
export function CancelOrderModal({ order, onClose, onDone }: { order: { id: number; number: string; version: number } | null; onClose: () => void; onDone: (m: string) => void }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setReason(''); setNote(''); setError(null); }, [order]);
  return (
    <Modal open={!!order} onClose={onClose} title={order ? `№${order.number} цуцлах` : ''}
      footer={<><Button onClick={onClose}>Болих</Button><Button variant="danger" loading={busy} disabled={!reason || note.replace(/\s/g, '').length < 5}
        onClick={async () => {
          if (!order) return;
          setBusy(true); setError(null);
          try { await api(`/api/orders/${order.id}/cancel`, { method: 'POST', json: { reason, note, version: order.version } }); onDone(`№${order.number} цуцлагдлаа — нөөц суллагдсан`); }
          catch (e) { setError(msg(e)); } finally { setBusy(false); }
        }}>Цуцлах</Button></>}>
      <div className="flex flex-col gap-3">
        {error ? <Notice>{error}</Notice> : null}
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-muted">Шалтгаан
          <select id="creason" value={reason} onChange={(e) => setReason(e.target.value)} className="h-10 rounded-lg border border-line bg-surface px-2.5 text-ink">
            <option value="">— Сонгох —</option>
            {CANCEL_REASONS.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-muted">Тайлбар (5+ тэмдэгт)
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} className="rounded-lg border border-line bg-surface px-3 py-2 text-ink outline-none focus:border-accent" />
        </label>
      </div>
    </Modal>
  );
}

/** «Мөнгө орсон» баталгаажуулах (ахлах оператор, админ) */
export function PaidConfirmModal({ order, onClose, onDone }: { order: { id: number; number: string; total: number; phone: string } | null; onClose: () => void; onDone: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [order]);
  return (
    <Modal open={!!order} onClose={onClose} title={order ? `№${order.number} — мөнгө орсон уу?` : ''}
      footer={<><Button onClick={onClose}>Болих</Button><Button variant="dark" loading={busy} onClick={async () => {
        if (!order) return;
        setBusy(true); setError(null);
        try { await api(`/api/orders/${order.id}/paid`, { method: 'POST', json: {} }); onDone(`№${order.number} — мөнгө орсон, «Шинэ» боллоо`); }
        catch (e) { setError(msg(e)); } finally { setBusy(false); }
      }}>💵 Мөнгө орсон</Button></>}>
      <div className="flex flex-col gap-2 text-[14px]">
        {error ? <Notice>{error}</Notice> : null}
        {order ? <p>{formatPhone(order.phone)} · <b>{money(order.total)}</b> — урьдчилгаа орсныг шалгасан бол баталгаажуулна. Захиалга «Шинэ» болж хүргэлтэд орно.</p> : null}
      </div>
    </Modal>
  );
}
