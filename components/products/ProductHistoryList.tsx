'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';

type Change = { from: unknown; to: unknown };
export interface HistoryItem {
  id: string; at: string; actorId: string | null; actorName: string; action: string; actionLabel: string; productId: number | null;
  tags: string[]; important: boolean; reviewable: boolean;
  details: { reason?: string; code?: string; name?: string; changes?: Record<string, Change>; bulk?: boolean } | null;
  review: { by: string; at: string } | null;
}
export interface HistoryResp { items: HistoryItem[]; total: number; page: number; pageSize: number; canReview: boolean; unreviewed: number }

const FIELD: Record<string, string> = {
  code: 'Код', name: 'Нэр', description: 'Тайлбар', category: 'Ангилал', season: 'Улирал', price: 'Үнэ', costPrice: 'Өртөг',
  colors: 'Өнгө', sizes: 'Хэмжээ', variants: 'Хувилбар', status: 'Төлөв', image: 'Зураг', imageColor: 'Зургийн өнгө',
  mainImage: 'Үндсэн зураг', imageOrder: 'Зургийн дараалал',
};
const TAG: Record<string, { l: string; c: string }> = {
  price: { l: 'Үнэ', c: 'bg-bad-soft text-bad-ink' }, code: { l: 'Код', c: 'bg-bad-soft text-bad-ink' },
  status: { l: 'Төлөв', c: 'bg-warn-soft text-warn' }, cost: { l: 'Өртөг', c: 'bg-bad-soft text-bad-ink' },
  image: { l: 'Зураг', c: 'bg-info-soft text-info' }, variant: { l: 'Хувилбар', c: 'bg-info-soft text-info' },
  category: { l: 'Ангилал', c: 'bg-surface2 text-muted' }, season: { l: 'Улирал', c: 'bg-surface2 text-muted' },
  info: { l: 'Мэдээлэл', c: 'bg-surface2 text-muted' }, created: { l: 'Шинэ', c: 'bg-ok-soft text-ok-ink' },
};

function show(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if ((field === 'price' || field === 'costPrice') && typeof v === 'number') return money(v);
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  if (typeof v === 'object') return '';
  return String(v);
}

function Changes({ changes }: { changes: Record<string, Change> }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
      {Object.entries(changes).map(([f, c]) => {
        if (f === 'variants' && c.to && typeof c.to === 'object') {
          return Object.entries(c.to as Record<string, Change>).map(([label, vc]) => (
            <div key={f + label} className="contents">
              <dt className="font-semibold text-muted">{label}</dt>
              <dd className="min-w-0 break-words"><span className="text-subtle line-through">{show('price', vc.from)}</span> → <strong>{show('price', vc.to)}</strong></dd>
            </div>
          ));
        }
        return (
          <div key={f} className="contents">
            <dt className="font-semibold text-muted">{FIELD[f] ?? f}</dt>
            <dd className="min-w-0 break-words">
              {c.from !== null && c.from !== undefined ? <><span className="text-subtle line-through">{show(f, c.from)}</span> → </> : null}
              <strong className={clsx((f === 'price' || f === 'code' || f === 'costPrice') && 'text-bad-ink')}>{show(f, c.to)}</strong>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function HistoryCard({ item, canReview, onReviewed, onActor, selfId, allowSelf = false }: {
  item: HistoryItem; canReview?: boolean; selfId?: string; allowSelf?: boolean; onReviewed?: () => void; onActor?: (id: string, name: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = item.details;
  async function review() {
    setBusy(true); setErr(null);
    try { await api(`/api/products/history/${item.id}/review`, { method: 'POST', json: {} }); onReviewed?.(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Алдаа'); }
    finally { setBusy(false); }
  }
  return (
    <li className={clsx('flex flex-col gap-2.5 rounded-[14px] border bg-surface p-3.5', item.important && !item.review ? 'border-bad/50' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {item.important ? <span className="rounded-md bg-bad px-1.5 py-0.5 text-[11px] font-extrabold text-white">ЧУХАЛ</span> : null}
        <span className="text-[14px] font-bold">{item.actionLabel}</span>
        {item.productId && d?.code ? <Link href={`/products/${item.productId}`} className="text-[14px] font-semibold text-accent-ink">{d.code} · {d.name}</Link> : null}
        <span className="ml-auto text-[12.5px] text-subtle">{ubDateTime(item.at)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {onActor && item.actorId ? (
          <button type="button" onClick={() => onActor(item.actorId!, item.actorName)} className="inline-flex items-center gap-1.5 rounded-lg bg-surface2 px-2 py-1 text-[13px] font-bold">
            <Icon name="user" size={14} />{item.actorName}
          </button>
        ) : <span className="inline-flex items-center gap-1.5 rounded-lg bg-surface2 px-2 py-1 text-[13px] font-bold"><Icon name="user" size={14} />{item.actorName}</span>}
        {item.tags.map((t) => TAG[t] ? <span key={t} className={clsx('rounded-md px-1.5 py-0.5 text-[11.5px] font-bold', TAG[t]!.c)}>{TAG[t]!.l}</span> : null)}
      </div>
      {d?.reason ? <p className="rounded-lg border-l-0 bg-accent-soft px-3 py-2 text-[13.5px]"><span className="font-semibold text-accent-ink">Тайлбар: </span>{d.reason}</p> : null}
      {d?.changes ? <Changes changes={d.changes} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        {item.review
          ? <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ok-ink"><Icon name="check" size={14} strokeWidth={2.6} />Шалгасан · {item.review.by} · {ubDateTime(item.review.at)}</span>
          : item.reviewable ? <span className="text-[12.5px] font-semibold text-warn">Шалгаагүй</span> : null}
        {canReview && !item.review && item.reviewable && (allowSelf || item.actorId !== selfId) ? <Button size="sm" variant="dark" loading={busy} onClick={review} className="ml-auto">Шалгасан</Button> : null}
      </div>
      {err ? <Notice>{err}</Notice> : null}
    </li>
  );
}

/** Нэг барааны түүх (засварын хуудсанд) */
export function ProductHistoryList({ productId, compact }: { productId: number; compact?: boolean }) {
  const [data, setData] = useState<HistoryResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await api<HistoryResp>(`/api/products/history?productId=${productId}`)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Түүх ачаалж чадсангүй'); }
  }, [productId]);
  useEffect(() => { load(); }, [load]);
  if (err) return <Notice>{err}</Notice>;
  if (!data) return <p className="text-[13px] text-muted">Ачаалж байна…</p>;
  if (!data.items.length) return <p className="text-[13px] text-muted">Түүх алга</p>;
  return <ul className="flex flex-col gap-2">{data.items.slice(0, compact ? 10 : 50).map((i) => <HistoryCard key={i.id} item={i} />)}</ul>;
}
