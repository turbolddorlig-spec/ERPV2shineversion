'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
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

export function OrderForm({ edit }: { edit?: EditOrder }) {
  const router = useRouter();
  const [pages, setPages] = useState<{ id: number; name: string }[]>([]);
  const [fees, setFees] = useState({ feeUB: 5000, feeRural: 10000 });
  const [pageId, setPageId] = useState(edit ? String(edit.pageId) : '');
  const [phone, setPhone] = useState(edit?.phone ?? '');
  const [extraPhone, setExtraPhone] = useState(edit?.extraPhone ?? '');
  const [province, setProvince] = useState(edit?.province ?? UB);
  const [district, setDistrict] = useState(edit?.district ?? '');
  const [khoroo, setKhoroo] = useState(edit?.khoroo ? String(edit.khoroo) : '');
  const [detail, setDetail] = useState(edit?.addressDetail ?? '');
  const [note, setNote] = useState(edit?.note ?? '');
  const [dateMode, setDateMode] = useState<'tomorrow' | 'today' | 'other'>(edit ? (edit.deliveryDate === ubDay() ? 'today' : edit.deliveryDate === ubDay(1) ? 'tomorrow' : 'other') : 'tomorrow');
  const [otherDate, setOtherDate] = useState(edit?.deliveryDate ?? ubDay(2));
  const [prepaidWait, setPrepaidWait] = useState(false);
  const [lines, setLines] = useState<FormLine[]>(edit ? edit.lines.map((l) => ({ ...l, description: null, discountReason: l.discountReason ?? '', available: null })) : []);
  const [feeOverride, setFeeOverride] = useState<string | null>(edit?.deliveryFeeEdited ? String(edit.deliveryFee) : null);
  const [feeReason, setFeeReason] = useState('');
  const [blacklistNote, setBlacklistNote] = useState('');
  const [card, setCard] = useState<Card | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [popular, setPopular] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idemKey] = useState(newKey);
  const qReq = useRef(0);

  useEffect(() => {
    api<{ pages: { id: number; name: string }[]; lastPageId: number | null; fees: { feeUB: number; feeRural: number } }>('/api/orders/pages').then((r) => {
      setPages(r.pages); setFees(r.fees);
      if (!edit) setPageId((p) => p || (r.lastPageId ? String(r.lastPageId) : ''));
    }).catch(() => undefined);
    const sp = new URLSearchParams(window.location.search);
    if (!edit) {
      if (sp.get('phone')) setPhone(sp.get('phone')!);
      if (sp.get('pageId')) setPageId(sp.get('pageId')!);
      const v = sp.get('variantId');
      if (v) api<{ items: Hit[] }>(`/api/products/search?q=${encodeURIComponent(sp.get('code') ?? '')}&limit=10`).then((r) => { const h = r.items.find((x) => String(x.variantId) === v); if (h) setLines([hitToLine(h)]); }).catch(() => undefined);
    } else {
      // Давхар захиалгаас «тэр захиалгад бараа нэмэх»
      try {
        const raw = sessionStorage.getItem(`orderAdd:${edit.id}`);
        if (raw) {
          sessionStorage.removeItem(`orderAdd:${edit.id}`);
          const add = JSON.parse(raw) as FormLine[];
          setLines((ls) => { const m = [...ls]; for (const a of add) { const i = m.findIndex((x) => x.variantId === a.variantId); if (i >= 0) m[i] = { ...m[i]!, qty: m[i]!.qty + a.qty }; else m.push(a); } return m; });
        }
      } catch { /* ignore */ }
    }
  }, [edit]);

  // Үйлчлүүлэгчийн карт (#51)
  useEffect(() => {
    const ph = [phone, extraPhone].map((x) => x.replace(/\D/g, '')).filter((x) => x.length === 8);
    if (!ph.length) { setCard(null); return; }
    const t = setTimeout(() => api<Card>(`/api/orders/customer?${ph.map((p) => `phone=${p}`).join('&')}`).then(setCard).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [phone, extraPhone]);

  useEffect(() => {
    if (!pageId) return;
    api<{ items: Hit[] }>(`/api/orders/popular?pageId=${pageId}`).then((r) => setPopular(r.items)).catch(() => setPopular([]));
  }, [pageId]);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits([]); return; }
    const id = ++qReq.current;
    const t = setTimeout(() => api<{ items: Hit[] }>(`/api/products/search?q=${encodeURIComponent(term)}&limit=12`).then((r) => { if (id === qReq.current) setHits(r.items); }).catch(() => undefined), 220);
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
  const dup = card?.active && card.active.id !== edit?.id ? card.active : null;
  const resultLabel = edit ? 'Хадгалах' : !ub || prepaidWait ? 'Захиалга үүсгэх · Төлбөр хүлээж буй' : scheduled ? 'Захиалга үүсгэх · Он сар өдөртэй' : 'Захиалга үүсгэх · Шинэ';
  const addr = useMemo(() => fullAddress({ province, district: ub ? district : null, khoroo: khoroo ? Number(khoroo) : null, addressDetail: detail }), [province, district, khoroo, detail, ub]);

  function addHit(h: Hit) {
    setLines((ls) => { const i = ls.findIndex((x) => x.variantId === h.variantId); if (i >= 0) { const m = [...ls]; m[i] = { ...m[i]!, qty: m[i]!.qty + 1 }; return m; } return [...ls, hitToLine(h)]; });
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

  function addToExisting() {
    if (!dup) return;
    try { sessionStorage.setItem(`orderAdd:${dup.id}`, JSON.stringify(lines)); } catch { /* ignore */ }
    router.push(`/orders/${dup.id}/edit`);
  }

  async function submit() {
    setError(null);
    if (!lines.length) return setError('Дор хаяж нэг бараа нэмнэ үү');
    const badDisc = lines.find((l) => l.unitPrice < l.listPrice && l.discountReason.replace(/\s/g, '').length < 5);
    if (badDisc) return setError(`«${badDisc.name}» үнийг бууруулсан шалтгаанаа бичнэ үү (5+ тэмдэгт)`);
    const body = {
      phone, extraPhone: extraPhone || null, province, district: ub ? district : null, khoroo: ub && khoroo ? Number(khoroo) : null, addressDetail: detail,
      note, pageId: Number(pageId), deliveryDate, lines: lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice, discountReason: l.discountReason || undefined })),
      ...(feeOverride !== null && feeOverride !== '' ? { deliveryFee: Number(feeOverride), feeReason } : {}),
      ...(card?.blacklist.length ? { blacklistNote } : {}),
    };
    setBusy(true);
    // Сүлжээ тасарвал ижил түлхүүрээр дахин илгээнэ — давхар захиалга үүсэхгүй (#47)
    for (let attempt = 0; ; attempt++) {
      try {
        if (edit) {
          await api(`/api/orders/${edit.id}`, { method: 'PATCH', json: { ...body, version: edit.version } });
          router.push(`/orders/${edit.id}?done=${encodeURIComponent('Хадгаллаа')}`);
        } else {
          const r = await api<{ order: { number: string } }>('/api/orders', { method: 'POST', json: { ...body, prepaidWait, idemKey } });
          router.push(`/orders?done=${encodeURIComponent(`№${r.order.number} захиалга үүслээ`)}`);
        }
        router.refresh();
        return;
      } catch (e) {
        if (e instanceof ApiError) { setError(e.message); break; }
        if (attempt >= 3) { setError('Сүлжээний алдаа. Дахин дарахад давхар захиалга үүсэхгүй.'); break; }
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    setBusy(false);
  }

  const sec = 'flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card';
  return (
    <div className="grid gap-4 pb-32 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-w-0 flex-col gap-4">
        <section className={sec}>
          <h2 className="text-[16px] font-extrabold">Үйлчлүүлэгч</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-muted">Утас
              <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d\s-]/g, ''))} onPaste={onPhonePaste} placeholder="9911 2233" autoFocus={!edit}
                className="h-12 rounded-xl border border-line bg-surface px-3.5 text-[17px] font-bold text-ink outline-none focus:border-accent" />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-muted">Нэмэлт утас
              <input inputMode="tel" value={extraPhone} onChange={(e) => setExtraPhone(e.target.value.replace(/[^\d\s-]/g, ''))} placeholder="(заавал биш)"
                className="h-12 rounded-xl border border-line bg-surface px-3.5 text-[16px] text-ink outline-none focus:border-accent" />
            </label>
          </div>
          {card ? <CustomerCard card={card} dup={dup} onAddress={() => { if (card.lastAddress) { setProvince(card.lastAddress.province); setDistrict(card.lastAddress.district ?? ''); setKhoroo(card.lastAddress.khoroo ? String(card.lastAddress.khoroo) : ''); setDetail(card.lastAddress.addressDetail); } }}
            onAddToExisting={addToExisting} hasLines={lines.length > 0}
            onCall={(c) => { if (c.pageId) setPageId(String(c.pageId)); if (c.variantId) api<{ items: Hit[] }>(`/api/products/search?q=${encodeURIComponent((c.product ?? '').match(/\(([^)]+)\)$/)?.[1] ?? '')}&limit=5`).then((r) => { const h = r.items.find((x) => x.variantId === c.variantId); if (h) addHit(h); }).catch(() => undefined); }} /> : null}
          {card?.blacklist.length ? (
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-bad-ink">Хар жагсаалттай — яагаад авч байгаагаа бичнэ үү (5+ тэмдэгт)
              <textarea rows={2} value={blacklistNote} onChange={(e) => setBlacklistNote(e.target.value)} className="rounded-xl border border-bad bg-surface px-3.5 py-2.5 text-ink outline-none" />
            </label>
          ) : null}
        </section>

        <section className={sec}>
          <h2 className="text-[16px] font-extrabold">Хаяг</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Select id="province" label="Аймаг / хот" value={province} onChange={(e) => { setProvince(e.target.value); if (!isUB(e.target.value)) { setDistrict(''); setKhoroo(''); } }}>
              {PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
            {ub ? (
              <>
                <Select id="district" label="Дүүрэг" value={district} onChange={(e) => { setDistrict(e.target.value); setKhoroo(''); }}>
                  <option value="">— Сонгох —</option>
                  {Object.keys(UB_DISTRICTS).map((d) => <option key={d} value={d}>{d}</option>)}
                </Select>
                <Select id="khoroo" label="Хороо" value={khoroo} onChange={(e) => setKhoroo(e.target.value)} disabled={!district}>
                  <option value="">Хороо тодорхойгүй</option>
                  {district ? Array.from({ length: UB_DISTRICTS[district]! }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}-р хороо</option>) : null}
                </Select>
              </>
            ) : null}
          </div>
          <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-muted">Дэлгэрэнгүй (байр, орц, тоот)
            <input value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Нарны хороолол 45-р байр, 3 орц, 56 тоот" className="h-12 rounded-xl border border-line bg-surface px-3.5 text-ink outline-none focus:border-accent" />
          </label>
          <p className="rounded-xl bg-surface2 px-3.5 py-2.5 text-[14px] font-semibold">📍 {addr}</p>
          {!ub ? <Notice tone="warn">Орон нутаг — заавал урьдчилгаатай: «Төлбөр хүлээж буй» төлөвтэй үүснэ.</Notice> : null}
        </section>

        <section className={sec}>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-[16px] font-extrabold">Бараа</h2>
            <Select id="page" className="min-w-[200px]" label="Пэйж" value={pageId} onChange={(e) => setPageId(e.target.value)}>
              <option value="">— Сонгох —</option>
              {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
          {popular.length ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold text-subtle">Энэ пэйжийн түгээмэл (7 хоног) — нэг даралтаар нэмнэ</span>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {popular.map((h) => (
                  <button key={h.variantId} type="button" disabled={h.available <= 0} onClick={() => addHit(h)} className="flex w-[120px] shrink-0 flex-col items-center gap-1 rounded-xl border border-line bg-surface p-2 text-center text-[12px] hover:bg-surface2 disabled:opacity-50">
                    <Thumb src={h.thumb} alt={h.fullName} size={56} />
                    <span className="line-clamp-2 font-semibold">{h.fullName}</span>
                    <span className="text-subtle">{money(h.price)} · {h.available}ш</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="relative">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle"><Icon name="search" size={18} /></span>
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && hits[0] && hits[0].available > 0) { e.preventDefault(); addHit(hits[0]); } }}
              placeholder="Бараа хайх: код, нэр, өнгө…" aria-label="Бараа хайх" className="h-12 w-full rounded-xl border border-line bg-surface pl-11 pr-3 text-[15px] outline-none focus:border-accent" />
            {hits.length ? (
              <ul className="absolute inset-x-0 top-full z-30 mt-1 max-h-[60vh] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-pop">
                {hits.map((h) => (
                  <li key={h.variantId} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface2">
                    <Thumb src={h.thumb} alt={h.fullName} size={48} zoom={h.variantCode} />
                    <button type="button" disabled={h.available <= 0} onClick={() => addHit(h)} className="flex min-w-0 flex-1 flex-col text-left disabled:opacity-50">
                      <span className="truncate text-[14.5px] font-semibold">{h.fullName}</span>
                      <span className="text-[12px] text-subtle">{h.variantCode} · {money(h.price)}{h.deliveryIncluded ? '' : ' + хүргэлт'} · <span className={h.available > 0 ? 'text-ok-ink' : 'font-bold text-bad-ink'}>{h.available > 0 ? `${h.available} ш боломжтой` : 'дууссан'}</span></span>
                      {h.description ? <span className="line-clamp-1 text-[12px] text-muted">{h.description}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {lines.length ? (
            <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
              {lines.map((l) => {
                const lowered = l.unitPrice < l.listPrice;
                return (
                  <li key={l.variantId} className="flex flex-col gap-2 px-3 py-3">
                    <div className="flex flex-wrap items-center gap-3">
                      {l.thumb ? <ZoomButton images={[{ src: l.image ?? largeOf(l.thumb), alt: `${l.name} ${l.label}`, name: l.code }]} label={`${l.name} — томруулах`}><Thumb src={l.thumb} alt={l.name} size={52} /></ZoomButton> : <Thumb src={null} alt={l.name} size={52} />}
                      <span className="flex min-w-[140px] flex-1 flex-col">
                        <span className="text-[15px] font-bold">{l.name}{l.label ? <span className="text-muted"> · {l.label}</span> : null}</span>
                        <span className="text-[12px] text-subtle">{l.code}{l.available !== null ? ` · ${l.available} ш боломжтой` : ''}{l.deliveryIncluded ? '' : ' · хүргэлт тусдаа'}</span>
                        {l.description ? <span className="text-[12px] text-muted">{l.description}</span> : null}
                      </span>
                      <label className="flex flex-col text-[11.5px] text-subtle">Үнэ
                        <input inputMode="numeric" value={l.unitPrice} onChange={(e) => upd(l.variantId, { unitPrice: Math.min(l.listPrice, Number(e.target.value.replace(/\D/g, '')) || 0) })}
                          className={clsx('h-11 w-28 rounded-lg border bg-surface px-2 text-right text-[15px] font-bold text-ink outline-none', lowered ? 'border-warn' : 'border-line')} />
                      </label>
                      <span className="flex items-center gap-1">
                        <button type="button" aria-label="Хасах" onClick={() => upd(l.variantId, { qty: Math.max(1, l.qty - 1) })} className="grid h-11 w-11 place-items-center rounded-lg border border-line text-[20px] font-bold">−</button>
                        <input inputMode="numeric" aria-label={`${l.code} тоо`} value={l.qty} onChange={(e) => upd(l.variantId, { qty: Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1) })} className="h-11 w-14 rounded-lg border border-line bg-surface text-center text-[16px] font-bold outline-none" />
                        <button type="button" aria-label="Нэмэх" onClick={() => upd(l.variantId, { qty: l.qty + 1 })} className="grid h-11 w-11 place-items-center rounded-lg border border-line text-[20px] font-bold">+</button>
                      </span>
                      <span className="w-24 text-right text-[15px] font-extrabold">{money(l.unitPrice * l.qty)}</span>
                      <button type="button" aria-label={`${l.code} хасах`} onClick={() => setLines((ls) => ls.filter((x) => x.variantId !== l.variantId))} className="grid h-11 w-11 place-items-center rounded-lg text-bad-ink hover:bg-bad-soft"><Icon name="trash" size={17} /></button>
                    </div>
                    {lowered ? (
                      <input value={l.discountReason} onChange={(e) => upd(l.variantId, { discountReason: e.target.value })} placeholder={`Үнийг ${money(l.listPrice)} → ${money(l.unitPrice)} болгосон шалтгаан (заавал)`}
                        className="h-10 rounded-lg border border-warn bg-warn-soft/40 px-3 text-[13.5px] text-ink outline-none" />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[14px] text-muted">Дээрх хайлтаар бараа нэмнэ үү</p>}
        </section>
      </div>

      <aside className="flex flex-col gap-4">
        <section className={sec}>
          <h2 className="text-[16px] font-extrabold">Хүргэх өдөр</h2>
          <div className="grid grid-cols-3 gap-1.5">
            {(['tomorrow', 'today', 'other'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={dateMode === m} onClick={() => setDateMode(m)} className={clsx('h-11 rounded-[11px] border text-[14px] font-semibold', dateMode === m ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>
                {m === 'tomorrow' ? 'Маргааш' : m === 'today' ? '🔴 Өнөөдөр' : 'Өөр өдөр'}
              </button>
            ))}
          </div>
          {dateMode === 'other' ? <input type="date" aria-label="Хүргэх өдөр" min={ubDay(1)} value={otherDate} onChange={(e) => setOtherDate(e.target.value)} className="h-11 rounded-xl border border-line bg-surface px-3" /> : null}
          {dateMode === 'today' ? <p className="text-[12.5px] text-bad-ink">Яаралтай — ахлах жолоочийн жагсаалтын эхэнд улаан тэмдэгтэй гарна.</p> : null}
          {!edit && ub ? (
            <label className="flex items-center gap-2 text-[14px] font-semibold">
              <input type="checkbox" checked={prepaidWait} onChange={(e) => setPrepaidWait(e.target.checked)} className="h-5 w-5 accent-[var(--accent)]" />Урьдчилгаа хүлээх
            </label>
          ) : null}
          <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-muted">Тэмдэглэл
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Жишээ: орой 6-аас хойш" className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-ink outline-none focus:border-accent" />
          </label>
        </section>

        <section className={sec}>
          <h2 className="text-[16px] font-extrabold">Дүн</h2>
          <dl className="flex flex-col gap-1.5 text-[14px]">
            <div className="flex justify-between"><dt className="text-muted">Бараа</dt><dd className="font-semibold">{money(subtotal)}</dd></div>
            {discount ? <div className="flex justify-between text-warn"><dt>Хөнгөлөлт</dt><dd className="font-semibold">−{money(discount)}</dd></div> : null}
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted">Хүргэлт</dt>
              <dd className="flex items-center gap-2">
                {feeOverride === null ? <><span className="font-semibold">{money(autoFee)}</span><button type="button" onClick={() => setFeeOverride(String(autoFee))} className="text-[12.5px] font-semibold text-accent-ink">Өөрчлөх</button></>
                  : <><input inputMode="numeric" aria-label="Хүргэлтийн төлбөр" value={feeOverride} onChange={(e) => setFeeOverride(e.target.value.replace(/\D/g, ''))} className="h-9 w-24 rounded-lg border border-warn bg-surface px-2 text-right font-bold" /><button type="button" onClick={() => { setFeeOverride(null); setFeeReason(''); }} className="text-[12.5px] font-semibold text-muted">Буцаах</button></>}
              </dd>
            </div>
            {feeOverride !== null && Number(feeOverride) !== autoFee ? <input value={feeReason} onChange={(e) => setFeeReason(e.target.value)} placeholder="Хүргэлтийн төлбөр өөрчилсөн шалтгаан (заавал)" className="h-10 rounded-lg border border-warn bg-warn-soft/40 px-3 text-[13px]" /> : null}
            <div className="mt-1 flex justify-between border-t border-line pt-2 text-[18px]"><dt className="font-bold">Төлөх</dt><dd className="font-extrabold">{money(total)}</dd></div>
          </dl>
        </section>
      </aside>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:left-[84px]">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-2">
          {error ? <Notice>{error}</Notice> : null}
          {dup && !edit ? <Notice tone="warn">Энэ утсаар идэвхтэй захиалга №{dup.number} байна — шинэ захиалга үүсгэхгүй, тэр захиалгад бараа нэмнэ.</Notice> : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-[15px] font-extrabold">{money(total)}</span>
            <Link href={edit ? `/orders/${edit.id}` : '/orders'} className="inline-flex h-12 items-center rounded-[11px] border border-line bg-surface px-4 font-semibold">Буцах</Link>
            {dup && !edit ? <Button variant="primary" size="lg" disabled={dup.inHandover} onClick={addToExisting}>№{dup.number} захиалгад бараа нэмэх</Button>
              : <Button variant="primary" size="lg" loading={busy} onClick={submit}>{resultLabel}</Button>}
          </div>
        </div>
      </div>
    </div>
  );
}

function CustomerCard({ card, dup, onAddress, onAddToExisting, hasLines, onCall }: {
  card: Card; dup: Card['active']; onAddress: () => void; onAddToExisting: () => void; hasLines: boolean; onCall: (c: Card['calls'][number]) => void;
}) {
  const empty = !card.stats.total && !card.blacklist.length && !card.calls.length;
  if (empty) return <p className="rounded-xl bg-surface2 px-3.5 py-2.5 text-[13px] text-muted">Шинэ үйлчлүүлэгч — өмнө захиалга байхгүй</p>;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface2/60 p-3 text-[13.5px]">
      {card.stats.total ? <p className="font-semibold">🧾 Өмнө {card.stats.total} захиалга · хүргэсэн {card.stats.delivered} · цуцалсан {card.stats.cancelled}</p> : null}
      {card.blacklist.map((b) => <p key={b.id} className="rounded-lg bg-bad-soft px-3 py-2 font-semibold text-bad-ink">⚠️ Хар жагсаалт ({formatPhone(b.phone)}): {b.reason} — {b.reportedBy}, {ubDateTime(b.createdAt)}{b.orderNumber ? ` · №${b.orderNumber}` : ''}</p>)}
      {dup ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-warn">
          <span className="font-semibold">🔁 Идэвхтэй захиалга №{dup.number} · {dup.statusLabel} · {dup.operatorName}</span>
          {dup.inHandover ? <span>— падаанд орсон тул нэмэх боломжгүй</span> : hasLines ? <button type="button" onClick={onAddToExisting} className="rounded-lg bg-ink px-3 py-1.5 text-[13px] font-bold text-on-ink">Тэнд бараа нэмэх</button> : <Link href={`/orders/${dup.id}`} className="font-bold underline">Харах</Link>}
        </div>
      ) : null}
      {card.calls.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-info-soft px-3 py-2 text-info">
          <span className="font-semibold">📞 {c.ownerName}: {c.product ?? '—'}{c.pageName ? ` · ${c.pageName}` : ''}{c.note ? ` · ${c.note}` : ''}</span>
          {c.variantId || c.pageId ? <button type="button" onClick={() => onCall(c)} className="rounded-lg bg-surface px-2.5 py-1 text-[12.5px] font-bold text-ink">Бараа, пэйж тохируулах</button> : null}
        </div>
      ))}
      {card.lastAddress ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted">📍 Сүүлийн хаяг: {card.lastAddress.fullAddress}</span>
          <button type="button" onClick={onAddress} className="rounded-lg border border-line bg-surface px-2.5 py-1 text-[12.5px] font-bold">Энэ хаягаар</button>
        </div>
      ) : null}
      {card.orders.length ? (
        <ul className="flex flex-col gap-0.5 text-[12.5px] text-muted">
          {card.orders.slice(0, 4).map((o) => <li key={o.id}><Link href={`/orders/${o.id}`} className="font-semibold text-ink">№{o.number}</Link> · {o.statusLabel} · {ubDateTime(o.createdAt).slice(0, 10)} · {money(o.total)} · {o.lines.join(', ')}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
