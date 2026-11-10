'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { api, ApiError } from '@/components/ui/api';
import { ItemPicker, linesFromQuery, newKey, type PickLine } from './ItemPicker';

type Mode = 'receipt' | 'issue' | 'transfer';
interface Wh { id: number; name: string; isPrimary: boolean }

const REASONS = [
  { v: 'DAMAGE', l: 'Гэмтэл' },
  { v: 'SAMPLE', l: 'Дээж, бэлэг, реклам' },
  { v: 'SUPPLIER_RETURN', l: 'Нийлүүлэгчид буцаасан' },
];

const TEXT: Record<Mode, { submit: string; done: string }> = {
  receipt: { submit: 'Орлого авах', done: 'Орлого бүртгэгдлээ' },
  issue: { submit: 'Зарлага гаргах', done: 'Зарлага бүртгэгдлээ' },
  transfer: { submit: 'Илгээх', done: 'Шилжүүлэг илгээгдлээ — хүлээн авах агуулах тоолж батална' },
};

/** Орлого / Зарлага / Шилжүүлэг — нэг маягт, нэг хайлт (#39) */
export function StockDocForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [whs, setWhs] = useState<Wh[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [toId, setToId] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<PickLine[]>([]);
  const [refill, setRefill] = useState(false);
  const [idemKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    api<{ items: Wh[] }>('/api/stock/warehouses').then((r) => {
      setWhs(r.items);
      const primary = r.items.find((w) => w.isPrimary);
      const from = sp.get('from');
      const to = sp.get('to');
      if (mode === 'transfer') {
        setWarehouseId(from ?? '');
        setToId(to ?? (primary && String(primary.id) !== from ? String(primary.id) : ''));
      } else setWarehouseId(from ?? (primary ? String(primary.id) : ''));
    }).catch(() => setError('Агуулахын жагсаалт ачаалж чадсангүй'));
    setRefill(sp.get('refill') === '1');
    if (sp.get('refill') === '1') setNote('Үндсэн агуулахын дүүргэлт');
    linesFromQuery(sp.get('lines')).then((l) => l.length && setLines(l)).catch(() => undefined);
  }, [mode]);

  async function submit() {
    setError(null);
    const body = {
      idemKey, note, lines: lines.filter((l) => l.qty > 0).map((l) => ({ variantId: l.variantId, qty: l.qty })),
      ...(mode === 'transfer' ? { fromWarehouseId: Number(warehouseId), toWarehouseId: Number(toId), refill } : { warehouseId: Number(warehouseId) }),
      ...(mode === 'issue' ? { reason } : {}),
    };
    if (!body.lines.length) return setError('Дор хаяж нэг бараа нэмнэ үү');
    if (mode === 'transfer' && (!warehouseId || !toId)) return setError('Илгээх, хүлээн авах агуулахаа сонгоно уу');
    if (mode !== 'transfer' && !warehouseId) return setError('Агуулахаа сонгоно уу');
    if (mode === 'issue' && !reason) return setError('Зарлагын шалтгаанаа сонгоно уу');
    if (mode === 'issue' && note.replace(/\s/g, '').length < 5) return setError('Тайлбар бичнэ үү (дор хаяж 5 тэмдэгт)');
    setBusy(true);
    try {
      const url = mode === 'receipt' ? '/api/stock/receipts' : mode === 'issue' ? '/api/stock/issues' : '/api/stock/transfers';
      await api(url, { method: 'POST', json: body });
      router.push(`${mode === 'transfer' ? '/warehouse/transfers' : '/warehouse'}?done=${encodeURIComponent(TEXT[mode].done)}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Хадгалж чадсангүй');
      setBusy(false);
    }
  }

  const stockWh = mode === 'receipt' ? null : Number(warehouseId) || null;
  return (
    <div className="flex max-w-[860px] flex-col gap-4 pb-28">
      {refill ? <Notice tone="info">Үндсэн агуулахын дүүргэлтийн шилжүүлэг — тоог шалгаад «Илгээх» дарна уу.</Notice> : null}
      <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card sm:grid-cols-2">
        {mode === 'transfer' ? (
          <>
            <Select id="from" label="Хаанаас (илгээх)" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">— Сонгох —</option>
              {whs.map((w) => <option key={w.id} value={w.id}>{w.name}{w.isPrimary ? ' (үндсэн)' : ''}</option>)}
            </Select>
            <Select id="to" label="Хаашаа (хүлээн авах)" value={toId} onChange={(e) => setToId(e.target.value)}>
              <option value="">— Сонгох —</option>
              {whs.filter((w) => String(w.id) !== warehouseId).map((w) => <option key={w.id} value={w.id}>{w.name}{w.isPrimary ? ' (үндсэн)' : ''}</option>)}
            </Select>
          </>
        ) : (
          <Select id="wh" label="Агуулах" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">— Сонгох —</option>
            {whs.map((w) => <option key={w.id} value={w.id}>{w.name}{w.isPrimary ? ' (үндсэн)' : ''}</option>)}
          </Select>
        )}
        {mode === 'issue' ? (
          <Select id="reason" label="Шалтгаан" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">— Сонгох —</option>
            {REASONS.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}
          </Select>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
        <h2 className="text-[16px] font-extrabold">Бараа</h2>
        <ItemPicker lines={lines} onChange={setLines} stockWarehouseId={stockWh} autoFocus />
      </section>

      <section className="flex flex-col gap-1.5 rounded-[18px] border border-line bg-surface p-4 shadow-card">
        <label htmlFor="note" className="text-[13px] font-semibold text-muted">{mode === 'issue' ? 'Тайлбар (заавал, 5+ тэмдэгт)' : 'Тэмдэглэл'}</label>
        <textarea id="note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
          placeholder={mode === 'receipt' ? 'Жишээ: Батаас ирсэн, карго 2' : mode === 'issue' ? 'Жишээ: Хайрцаг нь норж гэмтсэн' : 'Жишээ: Тавиур дүүргэх'}
          className="rounded-xl border border-line bg-surface px-3.5 py-3 outline-none focus:border-accent" />
      </section>

      {error ? <Notice>{error}</Notice> : null}

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:left-[84px]">
        <div className="mx-auto flex max-w-[1400px] items-center justify-end gap-2">
          <Link href={mode === 'transfer' ? '/warehouse/transfers' : '/warehouse'} className="inline-flex h-11 items-center rounded-[11px] border border-line bg-surface px-4 font-semibold">Буцах</Link>
          <Button variant="primary" size="lg" loading={busy} onClick={submit}>{TEXT[mode].submit}</Button>
        </div>
      </div>
    </div>
  );
}
