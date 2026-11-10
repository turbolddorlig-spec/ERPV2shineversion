'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { ReasonModal } from '@/components/ui/ReasonModal';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';
import { ubDateTime } from '@/lib/format';

type Status = 'SENT' | 'RECEIVED' | 'DISCREPANCY' | 'RESOLVED' | 'CANCELLED';
const TONE: Record<Status, 'info' | 'ok' | 'bad' | 'neutral' | 'warn'> = { SENT: 'info', RECEIVED: 'ok', DISCREPANCY: 'bad', RESOLVED: 'neutral', CANCELLED: 'neutral' };
interface Item {
  id: number; status: Status; statusLabel: string; refill: boolean; from: { id: number; name: string }; to: { id: number; name: string };
  lines: number; totalQty: number; shortQty: number; sentBy: string; sentAt: string; receivedBy: string | null; receivedAt: string | null; note: string | null;
}

const FILTERS = [
  { v: 'open', l: 'Нээлттэй' }, { v: 'SENT', l: 'Замдаа' }, { v: 'DISCREPANCY', l: 'Дутуу ирсэн' }, { v: 'all', l: 'Бүгд' },
];

export function TransfersClient({ canOperate }: { canOperate: boolean }) {
  const [status, setStatus] = useState('open');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: Item[]; total: number; pageSize: number } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const reqId = useRef(0);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('status')) setStatus(sp.get('status')!);
    if (sp.get('done')) setFlash(sp.get('done'));
  }, []);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    const r = await api<{ items: Item[]; total: number; pageSize: number }>(`/api/stock/transfers?status=${status}&page=${page}`);
    if (id === reqId.current) setData(r);
  }, [status, page]);
  useEffect(() => { load().catch(() => undefined); }, [load]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const chip = (on: boolean) => clsx('h-10 shrink-0 rounded-full border px-4 text-[13.5px] font-semibold', on ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-ink');

  return (
    <div className="flex flex-col gap-4">
      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => <button key={f.v} type="button" aria-pressed={status === f.v} onClick={() => { setStatus(f.v); setPage(1); }} className={chip(status === f.v)}>{f.l}</button>)}
        {canOperate ? <Link href="/warehouse/transfers/new" className="ml-auto inline-flex h-10 items-center gap-2 rounded-[11px] bg-accent px-4 text-[14px] font-bold text-on-accent"><Icon name="plus" size={16} />Шилжүүлэг</Link> : null}
      </div>
      <ul className="flex flex-col gap-2">
        {data?.items.map((t) => (
          <li key={t.id}>
            <Link href={`/warehouse/transfers/${t.id}`} className={clsx('flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[16px] border bg-surface p-3.5 shadow-card hover:bg-surface2/60', t.status === 'SENT' ? 'border-info/40' : t.status === 'DISCREPANCY' ? 'border-bad/50' : 'border-line')}>
              <span className="text-[13px] font-bold text-subtle">№{t.id}</span>
              <span className="flex min-w-0 flex-1 items-center gap-2 text-[15px] font-bold"><span className="truncate">{t.from.name}</span><Icon name="right" size={16} /><span className="truncate">{t.to.name}</span></span>
              <span className="flex items-center gap-1.5">
                {t.refill ? <Badge tone="accent">Дүүргэлт</Badge> : null}
                <Badge tone={TONE[t.status]}>{t.statusLabel}</Badge>
              </span>
              <span className="w-full text-[13px] text-muted sm:w-auto">{t.lines} бараа · {t.totalQty} ширхэг{t.shortQty ? <span className="font-bold text-bad-ink"> · дутуу {t.shortQty}</span> : null}</span>
              <span className="w-full text-[12.5px] text-subtle">Илгээсэн: {t.sentBy} · {ubDateTime(t.sentAt)}{t.receivedBy ? ` · Хүлээн авсан: ${t.receivedBy} · ${ubDateTime(t.receivedAt!)}` : ''}</span>
            </Link>
          </li>
        ))}
      </ul>
      {data && !data.items.length ? <div className="rounded-[16px] border border-dashed border-line bg-surface p-8 text-center text-muted">Шилжүүлэг алга</div> : null}
      {data && pages > 1 ? (
        <div className="flex justify-end gap-2">
          <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><Icon name="left" size={15} /> Өмнөх</Button>
          <Button size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Дараах <Icon name="right" size={15} /></Button>
        </div>
      ) : null}
    </div>
  );
}

interface Line { id: number; variantId: number; productId: number; code: string; name: string; label: string; thumb: string | null; sentQty: number; receivedQty: number | null; returnedQty: number; lostQty: number }
interface Detail extends Omit<Item, 'lines' | 'totalQty' | 'shortQty' | 'sentBy' | 'receivedBy'> { lines: Line[]; sentByName: string; receivedByName: string | null; resolvedByName: string | null; resolvedAt: string | null; resolveNote: string | null }

export function TransferDetail({ id, canOperate, canApprove }: { id: number; canOperate: boolean; canApprove: boolean }) {
  const router = useRouter();
  const [t, setT] = useState<Detail | null>(null);
  const [recv, setRecv] = useState<Record<number, string>>({});
  const [dec, setDec] = useState<Record<number, 'return' | 'loss'>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<null | 'cancel' | 'resolve'>(null);
  const [modalErr, setModalErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ transfer: Detail }>(`/api/stock/transfers/${id}`);
    setT(r.transfer);
    setRecv(Object.fromEntries(r.transfer.lines.map((l) => [l.variantId, String(l.receivedQty ?? l.sentQty)])));
  }, [id]);
  useEffect(() => { load().catch((e) => setError(e instanceof ApiError ? e.message : 'Ачаалж чадсангүй')); }, [load]);

  async function receive() {
    setError(null); setBusy(true);
    try {
      await api(`/api/stock/transfers/${id}/receive`, { method: 'POST', json: { lines: t!.lines.map((l) => ({ variantId: l.variantId, receivedQty: Number(recv[l.variantId] ?? 0) })) } });
      router.refresh(); await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Алдаа'); } finally { setBusy(false); }
  }
  async function act(note: string) {
    setModalErr(null); setBusy(true);
    try {
      if (modal === 'cancel') await api(`/api/stock/transfers/${id}/cancel`, { method: 'POST', json: { note } });
      else await api(`/api/stock/transfers/${id}/resolve`, { method: 'POST', json: { note, decisions: Object.entries(dec).map(([variantId, action]) => ({ variantId: Number(variantId), action })) } });
      setModal(null); router.refresh(); await load();
    } catch (e) { setModalErr(e instanceof ApiError ? e.message : 'Алдаа'); } finally { setBusy(false); }
  }

  if (!t) return error ? <Notice>{error}</Notice> : <p className="text-muted">Ачаалж байна…</p>;
  const receiving = t.status === 'SENT' && canOperate;
  const resolving = t.status === 'DISCREPANCY' && canApprove;
  const shortLines = t.lines.filter((l) => l.receivedQty !== null && l.sentQty - l.receivedQty - l.returnedQty - l.lostQty > 0);
  return (
    <div className="flex max-w-[900px] flex-col gap-4 pb-24">
      <section className="flex flex-wrap items-center gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
        <span className="flex items-center gap-2 text-[18px] font-extrabold">{t.from.name}<Icon name="right" size={18} />{t.to.name}</span>
        <Badge tone={TONE[t.status]}>{t.statusLabel}</Badge>
        {t.refill ? <Badge tone="accent">Дүүргэлт</Badge> : null}
        <p className="w-full text-[13px] text-muted">Илгээсэн: {t.sentByName} · {ubDateTime(t.sentAt)}{t.receivedByName ? ` · Хүлээн авсан: ${t.receivedByName} · ${ubDateTime(t.receivedAt!)}` : ''}{t.resolvedByName ? ` · ${t.status === 'CANCELLED' ? 'Цуцалсан' : 'Шийдсэн'}: ${t.resolvedByName} · ${ubDateTime(t.resolvedAt!)}` : ''}</p>
        {t.note ? <p className="w-full text-[13.5px]"><span className="font-semibold">Тэмдэглэл:</span> {t.note}</p> : null}
        {t.resolveNote ? <p className="w-full text-[13.5px]"><span className="font-semibold">Шийдвэрийн тайлбар:</span> {t.resolveNote}</p> : null}
      </section>
      {receiving ? <Notice tone="info">Ирсэн барааг тоолоод тоог оруулна уу. Дутуу ирсэн бол бодит тоог бичнэ — зөрүү админд харагдана.</Notice> : null}
      {resolving ? <Notice tone="warn">Дутуу ирсэн бараа бүрд шийдвэр сонгоно уу: илгээсэн агуулах руу буцаах (олдсон) эсвэл хорогдол.</Notice> : null}
      <ul className="flex flex-col divide-y divide-line rounded-[18px] border border-line bg-surface shadow-card">
        {t.lines.map((l) => {
          const short = l.receivedQty === null ? 0 : l.sentQty - l.receivedQty;
          const open = l.receivedQty !== null && l.sentQty - l.receivedQty - l.returnedQty - l.lostQty > 0;
          return (
            <li key={l.id} className="flex flex-wrap items-center gap-3 px-3.5 py-3">
              <Thumb src={l.thumb} alt={`${l.name} ${l.label}`} size={44} zoom={l.code} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[14.5px] font-semibold">{l.name}{l.label ? <span className="text-muted"> · {l.label}</span> : null}</span>
                <span className="text-[12px] text-subtle">{l.code} · <Link href={`/warehouse/products/${l.productId}?variantId=${l.variantId}`} className="font-semibold text-accent-ink">Түүх</Link></span>
              </span>
              <span className="text-right text-[13px]"><span className="block text-[16px] font-extrabold">{l.sentQty}</span><span className="text-subtle">илгээсэн</span></span>
              {receiving ? (
                <label className="flex flex-col items-end gap-0.5 text-[12px] text-subtle">
                  <input inputMode="numeric" aria-label={`${l.code} ирсэн тоо`} value={recv[l.variantId] ?? ''} onChange={(e) => setRecv((r) => ({ ...r, [l.variantId]: e.target.value.replace(/[^\d]/g, '') }))}
                    className={clsx('h-11 w-20 rounded-lg border bg-surface text-center text-[16px] font-bold outline-none focus:border-accent', Number(recv[l.variantId]) < l.sentQty ? 'border-bad' : 'border-line')} />
                  ирсэн
                </label>
              ) : l.receivedQty !== null ? (
                <span className="text-right text-[13px]"><span className={clsx('block text-[16px] font-extrabold', short ? 'text-bad-ink' : 'text-ok-ink')}>{l.receivedQty}</span><span className="text-subtle">ирсэн</span></span>
              ) : null}
              {short ? <span className="w-full text-[12.5px] font-semibold text-bad-ink sm:w-auto">Дутуу {short}{l.returnedQty ? ` · буцаасан ${l.returnedQty}` : ''}{l.lostQty ? ` · хорогдол ${l.lostQty}` : ''}</span> : null}
              {resolving && open ? (
                <span className="flex w-full gap-1.5 sm:w-auto">
                  {(['return', 'loss'] as const).map((a) => (
                    <button key={a} type="button" aria-pressed={dec[l.variantId] === a} onClick={() => setDec((d) => ({ ...d, [l.variantId]: a }))}
                      className={clsx('h-10 flex-1 rounded-[10px] border px-3 text-[13px] font-semibold', dec[l.variantId] === a ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>
                      {a === 'return' ? `${t.from.name} руу буцаах` : 'Хорогдол'}
                    </button>
                  ))}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? <Notice>{error}</Notice> : null}
      {receiving || resolving || (t.status === 'SENT' && canOperate) ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:left-[84px]">
          <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-end gap-2">
            <Link href="/warehouse/transfers" className="inline-flex h-11 items-center rounded-[11px] border border-line bg-surface px-4 font-semibold">Буцах</Link>
            {t.status === 'SENT' && canOperate ? <Button variant="danger" onClick={() => { setModalErr(null); setModal('cancel'); }}>Цуцлах</Button> : null}
            {receiving ? <Button variant="primary" size="lg" loading={busy} onClick={receive}>Хүлээн авсан</Button> : null}
            {resolving ? <Button variant="primary" size="lg" disabled={shortLines.some((l) => !dec[l.variantId])} onClick={() => { setModalErr(null); setModal('resolve'); }}>Шийдвэрлэх</Button> : null}
          </div>
        </div>
      ) : null}
      <ReasonModal open={modal !== null} busy={busy} error={modalErr} onCancel={() => setModal(null)} onConfirm={act}
        title={modal === 'cancel' ? 'Шилжүүлэг цуцлах' : 'Дутагдлыг шийдэх'} label={modal === 'cancel' ? 'Цуцлах шалтгаан' : 'Тайлбар'} confirmText={modal === 'cancel' ? 'Цуцлах' : 'Шийдвэрлэх'}
        summary={modal === 'cancel' ? `Бараа ${t.from.name} руу буцна.` : `${shortLines.length} барааны дутагдал`} />
    </div>
  );
}
