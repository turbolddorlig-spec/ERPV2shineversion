'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';
import { ZoomButton, largeOf } from '@/components/ui/Lightbox';
import { money, ubDateTime } from '@/lib/format';
import { PROVINCES, UB, UB_DISTRICTS, fullAddress, isUB } from '@/lib/geo';
import { formatPhone } from '@/lib/phone';

/** Хайлтын үр дүн (Модуль 1 + үлдэгдэл) */
interface Hit {
  variantId: number; variantCode: string; productId: number; name: string; label: string; fullName: string; price: number;
  thumb: string | null; image: string | null; description: string | null; deliveryIncluded: boolean; available: number; discontinued: boolean; soldQty?: number;
}
export interface FormLine {
  variantId: number; code: string; name: string; label: string; thumb: string | null; image: string | null; description: string | null;
  listPrice: number; unitPrice: number; qty: number; discountReason: string; deliveryIncluded: boolean; available: number | null;
}
interface Card {
  orders: { id: number; number: string; statusLabel: string; createdAt: string; total: number; lines: string[] }[];
  stats: { total: number; delivered: number; cancelled: number };
  active: { id: number; number: string; statusLabel: string; deliveryDate: string; inHandover: boolean; operatorName: string } | null;
  blacklist: { id: number; phone: string; reason: string; reportedBy: string; createdAt: string; orderNumber: string | null }[];
  calls: { id: number; phone: string; note: string | null; product: string | null; variantId: number | null; pageId: number | null; pageName: string | null; ownerName: string; attempts: number; createdAt: string }[];
  lastAddress: { province: string; district: string | null; khoroo: number | null; addressDetail: string; fullAddress: string } | null;
}
export interface EditOrder {
  id: number; number: string; version: number; status: string; phone: string; extraPhone: string | null; province: string; district: string | null; khoroo: number | null;
  addressDetail: string; note: string | null; pageId: number; deliveryDate: string; deliveryFee: number; deliveryFeeEdited: boolean; blacklistNote: string | null; inHandover: boolean;
  lines: { variantId: number; code: string; name: string; label: string; thumb: string | null; image: string | null; listPrice: number; unitPrice: number; qty: number; discountReason: string | null; deliveryIncluded: boolean }[];
}
/** Цонх нээх үеийн урьдчилсан утга (дуудлагын бүртгэлээс «Захиалга» г.м.) */
export interface OrderPrefill { phone?: string; pageId?: number | null; variantId?: number | null; code?: string | null }

const ubDay = (add = 0) => new Date(Date.now() + 8 * 3600_000 + add * 86_400_000).toISOString().slice(0, 10);
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Чатаас хуулсан «+976 9911-2233, 8811 2244» → ['99112233', '88112244'] (#50) */
export function extractPhones(text: string): string[] {
  const t = text.replace(/\+?976[\s-]?/g, ' ');
  return [...new Set((t.match(/\d{4}[\s-]?\d{4}/g) ?? []).map((m) => m.replace(/\D/g, '')))];
}
const hitToLine = (h: Hit): FormLine => ({
  variantId: h.variantId, code: h.variantCode, name: h.name, label: h.label === 'Үндсэн' ? '' : h.label, thumb: h.thumb, image: h.image, description: h.description,
  listPrice: h.price, unitPrice: h.price, qty: 1, discountReason: '', deliveryIncluded: h.deliveryIncluded, available: h.available,
});
function mergeLines(base: FormLine[], add: FormLine[]) {
  const m = [...base];
  for (const a of add) { const i = m.findIndex((x) => x.variantId === a.variantId); if (i >= 0) m[i] = { ...m[i]!, qty: m[i]!.qty + a.qty }; else m.push(a); }
  return m;
}

// Хуучин ERP шиг нягт хэмжээ
const lbl = 'text-[12.5px] font-semibold text-muted';
const inp = 'h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-[13.5px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft';
const sel = `${inp} pr-7`;

/**
 * Захиалга үүсгэх / засах цонх — хуучин ERP-ийн дараалал (2026-11-11 эзний шаардлага):
 * зүүн: Пэйж → Утас, Нэмэлт утас → Дүүрэг, Хороо, Аймаг → Дэлгэрэнгүй хаяг → Оператор санамж → Хүргэх өдөр;
 * баруун: зөвхөн бараа (хайх → сонгосон). Доор: «N бараа | M ширхэг · Нийт», Болих · Захиалга үүсгэх.
 */
export function OrderModal({ open, edit, addLines, prefill, onClose, onDone, onAddToExisting }: {
  open: boolean; edit?: EditOrder | null; addLines?: FormLine[]; prefill?: OrderPrefill | null;
  onClose: () => void; onDone: (msg: string, orderId: number) => void; onAddToExisting?: (orderId: number, lines: FormLine[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} size="xl" title={edit ? `Захиалга №${edit.number} засах` : 'Шинэ захиалга'} subtitle={edit?.inHandover ? 'Падаанд орсон — барааг засахгүй' : 'Захиалгын мэдээлэл оруулна уу'}
      bodyClassName="min-h-0 flex-1 overflow-hidden">
      {open ? <OrderForm key={edit ? `e${edit.id}` : 'new'} edit={edit ?? undefined} addLines={addLines} prefill={prefill} onClose={onClose} onDone={onDone} onAddToExisting={onAddToExisting} onBusy={setBusy} /> : null}
    </Modal>
  );
}

function OrderForm({ edit, addLines, prefill, onClose, onDone, onAddToExisting, onBusy }: {
  edit?: EditOrder; addLines?: FormLine[]; prefill?: OrderPrefill | null; onClose: () => void; onDone: (msg: string, orderId: number) => void;
  onAddToExisting?: (orderId: number, lines: FormLine[]) => void; onBusy: (b: boolean) => void;
}) {
  const [pages, setPages] = useState<{ id: number; name: string }[]>([]);
  const [fees, setFees] = useState({ feeUB: 5000, feeRural: 10000 });
  const [pageId, setPageId] = useState(edit ? String(edit.pageId) : prefill?.pageId ? String(prefill.pageId) : '');
  const [phone, setPhone] = useState(edit?.phone ?? prefill?.phone ?? '');
  const [extraPhone, setExtraPhone] = useState(edit?.extraPhone ?? '');
  const [province, setProvince] = useState(edit?.province ?? UB);
  const [district, setDistrict] = useState(edit?.district ?? '');
  const [khoroo, setKhoroo] = useState(edit?.khoroo ? String(edit.khoroo) : '');
  const [detail, setDetail] = useState(edit?.addressDetail ?? '');
  const [note, setNote] = useState(edit?.note ?? '');
  const [dateMode, setDateMode] = useState<'tomorrow' | 'today' | 'other'>(edit ? (edit.deliveryDate === ubDay() ? 'today' : edit.deliveryDate === ubDay(1) ? 'tomorrow' : 'other') : 'tomorrow');
  const [otherDate, setOtherDate] = useState(edit?.deliveryDate ?? ubDay(2));
  const [prepaidWait, setPrepaidWait] = useState(false);
  const [lines, setLines] = useState<FormLine[]>(() => {
    const base = edit ? edit.lines.map((l) => ({ ...l, description: null, discountReason: l.discountReason ?? '', available: null })) : [];
    return addLines?.length ? mergeLines(base, addLines) : base;
  });
  const [feeOverride, setFeeOverride] = useState<string | null>(edit?.deliveryFeeEdited ? String(edit.deliveryFee) : null);
  const [feeReason, setFeeReason] = useState('');
  const [blacklistNote, setBlacklistNote] = useState('');
  const [card, setCard] = useState<Card | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const [popular, setPopular] = useState<Hit[]>([]);
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idemKey] = useState(newKey);
  const qReq = useRef(0);
  const setBusy = (b: boolean) => { setBusyState(b); onBusy(b); };

  useEffect(() => {
    api<{ pages: { id: number; name: string }[]; lastPageId: number | null; fees: { feeUB: number; feeRural: number } }>('/api/orders/pages').then((r) => {
      setPages(r.pages); setFees(r.fees);
      if (!edit) setPageId((p) => p || (r.lastPageId ? String(r.lastPageId) : ''));
    }).catch(() => undefined);
    if (!edit && prefill?.variantId) {
      api<{ items: Hit[] }>(`/api/products/search?q=${encodeURIComponent(prefill.code ?? '')}&limit=10`).then((r) => { const h = r.items.find((x) => x.variantId === prefill.variantId); if (h) setLines((ls) => (ls.length ? ls : [hitToLine(h)])); }).catch(() => undefined);
    }
  }, [edit, prefill]);

  // Үйлчлүүлэгчийн карт (#51)
  useEffect(() => {
    const ph = [phone, extraPhone].map((x) => x.replace(/\D/g, '')).filter((x) => x.length === 8);
    if (!ph.length) { setCard(null); return; }
    const t = setTimeout(() => api<Card>(`/api/orders/customer?${ph.map((p) => `phone=${p}`).join('&')}`).then(setCard).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [phone, extraPhone]);

  useEffect(() => {
    if (!pageId || edit) return;
    api<{ items: Hit[] }>(`/api/orders/popular?pageId=${pageId}`).then((r) => setPopular(r.items)).catch(() => setPopular([]));
  }, [pageId, edit]);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits([]); setSearching(false); return; }
    const id = ++qReq.current;
    setSearching(true);
    const t = setTimeout(() => api<{ items: Hit[] }>(`/api/products/search?q=${encodeURIComponent(term)}&limit=20`)
      .then((r) => { if (id === qReq.current) { setHits(r.items); setSearching(false); } }).catch(() => setSearching(false)), 220);
    return () => clearTimeout(t);
  }, [q]);

  const ub = isUB(province);
  const deliveryDate = dateMode === 'today' ? ubDay() : dateMode === 'tomorrow' ? ubDay(1) : otherDate;
  const scheduled = deliveryDate > ubDay(1);
  const subtotal = lines.reduce((a, l) => a + l.listPrice * l.qty, 0);
  const discount = lines.reduce((a, l) => a + (l.listPrice - l.unitPrice) * l.qty, 0);
  const autoFee = lines.some((l) => !l.deliveryIncluded) ? (ub ? fees.feeUB : fees.feeRural) : 0;
  const fee = feeOverride !== null && feeOverride !== '' ? Number(feeOverride) : autoFee;
  const total = subtotal - discount + fee;
  const pcs = lines.reduce((a, l) => a + l.qty, 0);
  const dup = card?.active && card.active.id !== edit?.id ? card.active : null;
  const statusHint = edit ? null : !ub || prepaidWait ? 'Төлбөр хүлээж буй' : scheduled ? 'Он сар өдөртэй' : 'Шинэ';
  const addr = useMemo(() => fullAddress({ province, district: ub ? district : null, khoroo: khoroo ? Number(khoroo) : null, addressDetail: detail }), [province, district, khoroo, detail, ub]);
  const locked = !!edit?.inHandover;

  function addHit(h: Hit) {
    if (locked) return;
    setLines((ls) => mergeLines(ls, [hitToLine(h)]));
    setQ(''); setHits([]);
  }
  const upd = (id: number, patch: Partial<FormLine>) => setLines((ls) => ls.map((l) => (l.variantId === id ? { ...l, ...patch } : l)));

  function onPhonePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const ph = extractPhones(e.clipboardData.getData('text'));
    if (!ph.length) return;
    e.preventDefault();
    setPhone(ph[0]!);
    if (ph[1] && !extraPhone) setExtraPhone(ph[1]);
  }

  async function submit() {
    setError(null);
    if (!lines.length) return setError('Дор хаяж нэг бараа нэмнэ үү');
    const badDisc = lines.find((l) => l.unitPrice < l.listPrice && l.discountReason.replace(/\s/g, '').length < 5);
    if (badDisc) return setError(`«${badDisc.name}» үнийг бууруулсан шалтгаанаа бичнэ үү (5+ тэмдэгт)`);
    const body = {
      phone, extraPhone: extraPhone || null, province, district: ub ? district : null, khoroo: ub && khoroo ? Number(khoroo) : null, addressDetail: detail,
      note, pageId: pages.some((p) => String(p.id) === pageId) ? Number(pageId) : edit && pageId === String(edit.pageId) ? Number(pageId) : 0, deliveryDate,
      lines: lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice, discountReason: l.discountReason || undefined })),
      ...(feeOverride !== null && feeOverride !== '' ? { deliveryFee: Number(feeOverride), feeReason } : {}),
      ...(card?.blacklist.length ? { blacklistNote } : {}),
    };
    setBusy(true);
    // Сүлжээ тасарвал ижил түлхүүрээр дахин илгээнэ — давхар захиалга үүсэхгүй (#47)
    for (let attempt = 0; ; attempt++) {
      try {
        if (edit) {
          await api(`/api/orders/${edit.id}`, { method: 'PATCH', json: { ...body, version: edit.version } });
          setBusy(false);
          onDone(`№${edit.number} хадгалагдлаа`, edit.id);
        } else {
          const r = await api<{ order: { id: number; number: string } }>('/api/orders', { method: 'POST', json: { ...body, prepaidWait, idemKey } });
          setBusy(false);
          onDone(`№${r.order.number} захиалга үүслээ`, r.order.id);
        }
        return;
      } catch (e) {
        if (e instanceof ApiError) { setError(e.message); break; }
        if (attempt >= 3) { setError('Сүлжээний алдаа. Дахин дарахад давхар захиалга үүсэхгүй.'); break; }
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    setBusy(false);
  }

  return (
    <div className="flex h-full max-h-[calc(94vh-56px)] flex-col">
      <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto px-4 py-3 md:grid-cols-2">
        {/* ───── Зүүн: үйлчлүүлэгч, хаяг ───── */}
        <div className="flex min-w-0 flex-col gap-3">
          <label className="flex flex-col gap-1"><span className={lbl}>Хуудас (пэйж)</span>
            <select value={pages.some((p) => String(p.id) === pageId) ? pageId : ''} onChange={(e) => setPageId(e.target.value)} className={sel} aria-label="Пэйж">
              <option value="">Пэйж сонгоогүй</option>
              {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1"><span className={lbl}>Утас <span className="text-bad-ink">*</span></span>
              <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d\s-]/g, ''))} onPaste={onPhonePaste} placeholder="99887766" data-autofocus={!edit ? true : undefined}
                className={clsx(inp, 'font-bold', (dup || card?.blacklist.some((b) => b.phone === phone.replace(/\D/g, ''))) && 'border-bad')} />
            </label>
            <label className="flex flex-col gap-1"><span className={lbl}>Нэмэлт утас</span>
              <input inputMode="tel" value={extraPhone} onChange={(e) => setExtraPhone(e.target.value.replace(/[^\d\s-]/g, ''))} placeholder="88776655" className={inp} />
            </label>
          </div>
          {card ? <CustomerCard card={card} dup={dup} hasLines={lines.length > 0}
            onAddress={() => { if (card.lastAddress) { setProvince(card.lastAddress.province); setDistrict(card.lastAddress.district ?? ''); setKhoroo(card.lastAddress.khoroo ? String(card.lastAddress.khoroo) : ''); setDetail(card.lastAddress.addressDetail); } }}
            onAddToExisting={() => { if (dup && onAddToExisting) onAddToExisting(dup.id, lines); }}
            onCall={(c) => { if (c.pageId) setPageId(String(c.pageId)); if (c.variantId) api<{ items: Hit[] }>(`/api/products/search?q=${encodeURIComponent((c.product ?? '').match(/\(([^)]+)\)$/)?.[1] ?? '')}&limit=5`).then((r) => { const h = r.items.find((x) => x.variantId === c.variantId); if (h) addHit(h); }).catch(() => undefined); }} /> : null}
          {card?.blacklist.length ? (
            <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-bad-ink">Хар жагсаалттай — яагаад авч байгаагаа бичнэ үү (5+ тэмдэгт)
              <textarea rows={2} value={blacklistNote} onChange={(e) => setBlacklistNote(e.target.value)} className="rounded-lg border border-bad bg-surface px-2.5 py-1.5 text-[13.5px] text-ink outline-none" />
            </label>
          ) : null}
          <div className={clsx('grid gap-3', ub ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-1')}>
            {ub ? (
              <>
                <label className="flex flex-col gap-1"><span className={lbl}>Дүүрэг <span className="text-bad-ink">*</span></span>
                  <select id="district" value={district} onChange={(e) => { setDistrict(e.target.value); setKhoroo(''); }} className={sel}>
                    <option value="">Дүүрэг сонгох</option>
                    {Object.keys(UB_DISTRICTS).map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1"><span className={lbl}>Хороо</span>
                  <select id="khoroo" value={khoroo} onChange={(e) => setKhoroo(e.target.value)} disabled={!district} className={sel}>
                    <option value="">Тодорхойгүй</option>
                    {district ? Array.from({ length: UB_DISTRICTS[district]! }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}-р хороо</option>) : null}
                  </select>
                </label>
              </>
            ) : null}
            <label className={clsx('flex flex-col gap-1', ub && 'col-span-2 sm:col-span-1')}><span className={lbl}>Аймаг <span className="text-bad-ink">*</span></span>
              <select id="province" value={province} onChange={(e) => { setProvince(e.target.value); if (!isUB(e.target.value)) { setDistrict(''); setKhoroo(''); } }} className={sel}>
                {PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1"><span className={lbl}>Дэлгэрэнгүй хаяг <span className="text-bad-ink">*</span></span>
            <textarea rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Хороолол, байр, тоот..." aria-label="Дэлгэрэнгүй хаяг"
              className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13.5px] text-ink outline-none focus:border-accent" />
            <span className="text-[12px] text-subtle">📍 {addr}</span>
          </label>
          {!ub ? <p className="rounded-lg bg-warn-soft px-2.5 py-1.5 text-[12.5px] text-warn">Орон нутаг — урьдчилгаатай: «Төлбөр хүлээж буй» төлөвтэй үүснэ.</p> : null}
          <label className="flex flex-col gap-1"><span className={lbl}>Оператор санамж</span>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Нэмэлт тэмдэглэл..." className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13.5px] text-ink outline-none focus:border-accent" />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className={lbl}>Хүргэх өдөр</span>
            <div className="grid grid-cols-3 gap-1.5">
              {(['tomorrow', 'today', 'other'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={dateMode === m} onClick={() => setDateMode(m)} className={clsx('h-9 rounded-lg border text-[13px] font-semibold', dateMode === m ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>
                  {m === 'tomorrow' ? 'Маргааш' : m === 'today' ? '🔴 Өнөөдөр' : 'Өөр өдөр'}
                </button>
              ))}
            </div>
            {dateMode === 'other' ? <input type="date" aria-label="Хүргэх өдөр" min={ubDay(1)} value={otherDate} onChange={(e) => setOtherDate(e.target.value)} className={inp} /> : null}
            {dateMode === 'other' && scheduled ? <p className="text-[12px] text-info">Он сар өдөртэй — тэр өдрийн өмнөх өдөр автоматаар «Шинэ» болно.</p> : null}
            {dateMode === 'today' ? <p className="text-[12px] text-bad-ink">Яаралтай — ахлах жолоочийн жагсаалтын эхэнд улаан тэмдэгтэй гарна.</p> : null}
            {!edit && ub ? (
              <label className="flex items-center gap-2 text-[13px] font-semibold">
                <input type="checkbox" checked={prepaidWait} onChange={(e) => setPrepaidWait(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />Урьдчилгаа хүлээх
              </label>
            ) : null}
          </div>
        </div>

        {/* ───── Баруун: бараа ───── */}
        <div className="flex min-w-0 flex-col gap-2.5">
          <span className={lbl}>Бараа <span className="text-bad-ink">*</span></span>
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle"><Icon name="search" size={15} /></span>
            <input value={q} onChange={(e) => setQ(e.target.value)} disabled={locked} onKeyDown={(e) => { if (e.key === 'Enter' && hits[0] && hits[0].available > 0) { e.preventDefault(); addHit(hits[0]); } }}
              placeholder="Бараа хайх (код эсвэл нэр)..." aria-label="Бараа хайх" className={clsx(inp, 'pl-8')} />
          </div>
          {q.trim() ? (
            <div className="max-h-[300px] overflow-y-auto rounded-lg border border-line p-1">
              {hits.length ? hits.map((h) => {
                const out = h.available <= 0;
                return (
                  <div key={h.variantId} className={clsx('flex items-center gap-2.5 rounded-md p-1.5', out ? 'opacity-50' : 'hover:bg-surface2')}>
                    <Thumb src={h.thumb} alt={h.fullName} size={44} zoom={h.variantCode} />
                    <button type="button" disabled={out} onClick={() => addHit(h)} className="flex min-w-0 flex-1 flex-col text-left disabled:cursor-not-allowed">
                      <span className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-semibold"><span className="text-subtle">{h.variantCode}</span><span className="min-w-0 truncate" title={h.fullName}>{h.name}{h.label && h.label !== 'Үндсэн' ? ` · ${h.label}` : ''}</span>{h.discontinued ? <span title="Барааны төлөв «Зогсоосон» — дахин татахгүй, үлдэгдэл дуустал зарна" className="rounded bg-warn-soft px-1 text-[11px] font-bold text-warn">Зогсоосон</span> : null}</span>
                      <span className="text-[12px] text-subtle">{money(h.price)}{h.deliveryIncluded ? '' : ' + хүргэлт'} · <span className={clsx('font-semibold', h.available > 0 ? 'text-ok-ink' : 'text-bad-ink')}>{h.available > 0 ? `${h.available}ш үлдсэн` : 'Дууссан'}</span></span>
                      {h.description ? <span title={h.description} className="line-clamp-1 break-all text-[11.5px] text-muted [overflow-wrap:anywhere]">{h.description}</span> : null}
                    </button>
                  </div>
                );
              }) : <p className="py-4 text-center text-[13px] text-muted">{searching ? 'Хайж байна…' : 'Бараа олдсонгүй'}</p>}
            </div>
          ) : popular.length && !edit ? (
            <div className="flex flex-col gap-1">
              <span className="text-[11.5px] text-subtle">Энэ пэйжийн түгээмэл (7 хоног)</span>
              <div className="flex gap-1.5 overflow-x-auto pb-1">
                {popular.map((h) => (
                  <button key={h.variantId} type="button" disabled={h.available <= 0} onClick={() => addHit(h)} className="flex w-[96px] shrink-0 flex-col items-center gap-0.5 rounded-lg border border-line bg-surface p-1.5 text-center text-[11px] hover:bg-surface2 disabled:opacity-50">
                    <Thumb src={h.thumb} alt={h.fullName} size={40} />
                    <span className="line-clamp-2 font-semibold">{h.fullName}</span>
                    <span className="text-subtle">{h.available}ш</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {lines.length ? (
            <div className="max-h-[340px] divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {lines.map((l) => {
                const lowered = l.unitPrice < l.listPrice;
                return (
                  <div key={l.variantId} className="flex flex-col gap-1.5 p-2">
                    <div className="flex items-center gap-2">
                      {l.thumb ? <ZoomButton images={[{ src: l.image ?? largeOf(l.thumb), alt: `${l.name} ${l.label}`, name: l.code }]} label={`${l.name} — томруулах`}><Thumb src={l.thumb} alt={l.name} size={36} /></ZoomButton> : <Thumb src={null} alt={l.name} size={36} />}
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13.5px] font-semibold">{l.name}{l.label ? <span className="text-muted"> · {l.label}</span> : null}</span>
                        <span className="text-[11.5px] text-subtle">{l.code}{l.available !== null ? ` | ${l.available}ш` : ''}{l.deliveryIncluded ? '' : ' · хүргэлт тусдаа'}</span>
                      </span>
                      {!locked ? <button type="button" aria-label={`${l.code} хасах`} onClick={() => setLines((ls) => ls.filter((x) => x.variantId !== l.variantId))} className="grid h-7 w-7 place-items-center rounded-md text-bad-ink hover:bg-bad-soft"><Icon name="trash" size={14} /></button> : null}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button type="button" aria-label="Хасах" disabled={locked || l.qty <= 1} onClick={() => upd(l.variantId, { qty: Math.max(1, l.qty - 1) })} className="grid h-7 w-7 place-items-center rounded-md border border-line font-bold disabled:opacity-40">−</button>
                      <input inputMode="numeric" aria-label={`${l.code} тоо`} disabled={locked} value={l.qty} onChange={(e) => upd(l.variantId, { qty: Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1) })} className="h-7 w-11 rounded-md border border-line bg-surface text-center text-[13px] font-bold outline-none" />
                      <button type="button" aria-label="Нэмэх" disabled={locked || (l.available !== null && l.qty >= l.available)} onClick={() => upd(l.variantId, { qty: l.qty + 1 })} className="grid h-7 w-7 place-items-center rounded-md border border-line font-bold disabled:opacity-40">+</button>
                      <span className="text-[12px] text-subtle">×</span>
                      <input inputMode="numeric" aria-label={`${l.code} үнэ`} disabled={locked} value={l.unitPrice} onChange={(e) => upd(l.variantId, { unitPrice: Math.min(l.listPrice, Number(e.target.value.replace(/\D/g, '')) || 0) })}
                        className={clsx('h-7 w-24 rounded-md border bg-surface px-1.5 text-right text-[13px] font-semibold outline-none', lowered ? 'border-warn' : 'border-line')} />
                      <span className="text-[12px] text-subtle">=</span>
                      <span className="ml-auto whitespace-nowrap text-[13.5px] font-bold">{money(l.unitPrice * l.qty)}</span>
                    </div>
                    {lowered ? <input value={l.discountReason} onChange={(e) => upd(l.variantId, { discountReason: e.target.value })} placeholder={`${money(l.listPrice)} → ${money(l.unitPrice)} болгосон шалтгаан (заавал)`} className="h-8 rounded-md border border-warn bg-warn-soft/40 px-2 text-[12.5px] text-ink outline-none" /> : null}
                  </div>
                );
              })}
            </div>
          ) : <p className="rounded-lg border border-dashed border-line px-3 py-5 text-center text-[13px] text-muted">Дээрх хайлтаар бараа нэмнэ үү</p>}
        </div>
      </div>

      {/* ───── Дүн (хуучин шиг) ───── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-info-soft/40 px-4 py-2 text-[13px]">
        <span className="text-muted">{lines.length} бараа | {pcs} ширхэг</span>
        {discount ? <span className="text-warn">Хөнгөлөлт −{money(discount)}</span> : null}
        <span className="flex items-center gap-1.5 text-muted">Хүргэлт
          {feeOverride === null ? <><b className="text-ink">{money(autoFee)}</b><button type="button" onClick={() => setFeeOverride(String(autoFee))} className="font-semibold text-accent-ink">өөрчлөх</button></>
            : <><input inputMode="numeric" aria-label="Хүргэлтийн төлбөр" value={feeOverride} onChange={(e) => setFeeOverride(e.target.value.replace(/\D/g, ''))} className="h-7 w-20 rounded-md border border-warn bg-surface px-1.5 text-right font-bold" /><button type="button" onClick={() => { setFeeOverride(null); setFeeReason(''); }} className="font-semibold">буцаах</button></>}
        </span>
        {feeOverride !== null && Number(feeOverride) !== autoFee ? <input value={feeReason} onChange={(e) => setFeeReason(e.target.value)} placeholder="Хүргэлт өөрчилсөн шалтгаан (заавал)" className="h-7 min-w-[220px] flex-1 rounded-md border border-warn bg-surface px-2 text-[12.5px]" /> : null}
        <span className="ml-auto flex items-baseline gap-2"><span className="font-semibold">Нийт:</span><span className="text-[19px] font-extrabold text-accent-ink">{money(total)}</span></span>
      </div>
      <div className="flex flex-col gap-2 border-t border-line bg-surface2/60 px-4 py-2.5 pb-[max(10px,env(safe-area-inset-bottom))]">
        {error ? <Notice>{error}</Notice> : null}
        {dup && !edit ? <Notice tone="warn">Энэ утсаар идэвхтэй захиалга №{dup.number} байна — шинэ захиалга үүсгэхгүй, тэр захиалгад бараа нэмнэ.</Notice> : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {statusHint ? <span className="mr-auto text-[12.5px] text-muted">Төлөв: <b className="text-ink">{statusHint}</b></span> : null}
          <Button size="sm" onClick={onClose} disabled={busy}>Болих</Button>
          {dup && !edit ? <Button size="sm" variant="primary" disabled={dup.inHandover || !onAddToExisting} onClick={() => onAddToExisting?.(dup.id, lines)}>№{dup.number} захиалгад бараа нэмэх</Button>
            : <Button size="sm" variant="primary" loading={busy} onClick={submit}>{edit ? 'Хадгалах' : 'Захиалга үүсгэх'}</Button>}
        </div>
      </div>
    </div>
  );
}

function CustomerCard({ card, dup, onAddress, onAddToExisting, hasLines, onCall }: {
  card: Card; dup: Card['active']; onAddress: () => void; onAddToExisting: () => void; hasLines: boolean; onCall: (c: Card['calls'][number]) => void;
}) {
  const empty = !card.stats.total && !card.blacklist.length && !card.calls.length;
  if (empty) return <p className="-mt-1 text-[12px] text-subtle">Шинэ үйлчлүүлэгч — өмнө захиалга байхгүй</p>;
  return (
    <div className="-mt-1 flex flex-col gap-1.5 rounded-lg border border-line bg-surface2/60 p-2 text-[12.5px]">
      {card.stats.total ? <p className="font-semibold">🧾 Өмнө {card.stats.total} захиалга · хүргэсэн {card.stats.delivered} · цуцалсан {card.stats.cancelled}</p> : null}
      {card.blacklist.map((b) => <p key={b.id} className="rounded-md bg-bad-soft px-2 py-1.5 font-semibold text-bad-ink">⚠️ Мөнгөө өгдөггүй хүн ({formatPhone(b.phone)}): {b.reason} — {b.reportedBy}{b.orderNumber ? ` · №${b.orderNumber}` : ''}</p>)}
      {dup ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-warn-soft px-2 py-1.5 text-warn">
          <span className="font-semibold">🔁 Давхар: идэвхтэй захиалга №{dup.number} · {dup.statusLabel} · {dup.operatorName}</span>
          {dup.inHandover ? <span>— падаанд орсон тул нэмэх боломжгүй</span> : hasLines ? <button type="button" onClick={onAddToExisting} className="rounded-md bg-ink px-2 py-1 text-[12px] font-bold text-on-ink">Тэнд бараа нэмэх</button> : <Link href={`/orders/${dup.id}`} className="font-bold underline">Харах</Link>}
        </div>
      ) : null}
      {card.calls.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-md bg-info-soft px-2 py-1.5 text-info">
          <span className="font-semibold">📞 Дуудлагын бүртгэлд: {c.product ?? '—'}{c.pageName ? ` · ${c.pageName}` : ''} · {c.ownerName}{c.note ? ` · ${c.note}` : ''}</span>
          {c.variantId || c.pageId ? <button type="button" onClick={() => onCall(c)} className="rounded-md bg-surface px-2 py-0.5 text-[12px] font-bold text-ink">Бараа, пэйж тохируулах</button> : null}
        </div>
      ))}
      {card.lastAddress ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted">📍 Сүүлийн хаяг: {card.lastAddress.fullAddress}</span>
          <button type="button" onClick={onAddress} className="rounded-md border border-line bg-surface px-2 py-0.5 text-[12px] font-bold">Энэ хаягаар</button>
        </div>
      ) : null}
      {card.orders.length ? (
        <ul className="flex flex-col gap-0.5 text-[12px] text-muted">
          {card.orders.slice(0, 3).map((o) => <li key={o.id}><Link href={`/orders/${o.id}`} className="font-semibold text-ink">№{o.number}</Link> · {o.statusLabel} · {ubDateTime(o.createdAt).slice(0, 10)} · {money(o.total)} · {o.lines.join(', ')}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
