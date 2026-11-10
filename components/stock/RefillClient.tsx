'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Notice } from '@/components/ui/Notice';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';

interface Item {
  variantId: number; productId: number; code: string; name: string; label: string; thumb: string | null; shelfCode: string | null;
  demand: number; onShelf: number; incoming: number; shortage: number; toSend: number; uncovered: number;
  sources: { warehouseId: number; name: string; qty: number }[];
}
interface Resp { primary: { id: number; name: string } | null; items: Item[]; plan: { warehouseId: number; name: string; lines: { variantId: number; qty: number }[] }[] }

/** Үндсэн агуулахын дүүргэлт (#39): захиалгын хэрэгцээ тавиураас их бол — хаанаас авах санал, нэг товчоор шилжүүлэг */
export function RefillClient({ canOperate }: { canOperate: boolean }) {
  const [d, setD] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<Resp>('/api/stock/refill').then(setD).catch((e) => setError(e instanceof ApiError ? e.message : 'Ачаалж чадсангүй')); }, []);
  if (error) return <Notice>{error}</Notice>;
  if (!d) return <p className="text-muted">Ачаалж байна…</p>;
  if (!d.primary) return <Notice tone="warn">Үндсэн агуулах тохируулаагүй байна. «Агуулахууд» хэсэгт нэмнэ үү.</Notice>;
  if (!d.items.length) return (
    <div className="flex flex-col items-center gap-2 rounded-[16px] border border-dashed border-line bg-surface p-10 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-ok-soft text-ok-ink"><Icon name="check" size={24} /></span>
      <p className="text-[16px] font-bold">{d.primary.name}-ийн тавиур хангалттай</p>
      <p className="text-[13.5px] text-muted">Хүргэлтэд гарах захиалгын бүх бараа үндсэн агуулахад байна.</p>
    </div>
  );
  const href = (p: Resp['plan'][number]) => `/warehouse/transfers/new?from=${p.warehouseId}&to=${d.primary!.id}&refill=1&lines=${p.lines.map((l) => `${l.variantId}:${l.qty}`).join(',')}`;
  return (
    <div className="flex flex-col gap-4">
      <Notice tone="warn">{d.primary.name}-ийн тавиурт <strong>{d.items.length}</strong> бараа дутуу байна — хүргэлтэд гарах захиалгад хүрэлцэхгүй. Дүүргэлт хийнэ үү.</Notice>
      {canOperate && d.plan.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[16px] font-extrabold">Нэг товчоор шилжүүлэх</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {d.plan.map((p) => (
              <Link key={p.warehouseId} href={href(p)} className="flex items-center gap-3 rounded-[16px] border border-accent/40 bg-accent-soft/60 p-3.5 hover:bg-accent-soft">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent text-on-accent"><Icon name="swap" size={20} /></span>
                <span className="flex flex-1 flex-col">
                  <span className="text-[15px] font-bold">{p.name} → {d.primary!.name}</span>
                  <span className="text-[13px] text-muted">{p.lines.length} бараа · {p.lines.reduce((s, l) => s + l.qty, 0)} ширхэг</span>
                </span>
                <Icon name="right" size={18} />
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      <ul className="flex flex-col gap-2">
        {d.items.map((it) => (
          <li key={it.variantId} className="flex flex-wrap items-center gap-3 rounded-[16px] border border-line bg-surface p-3.5 shadow-card">
            <Thumb src={it.thumb} alt={`${it.name} ${it.label}`} size={48} zoom={it.code} />
            <span className="flex min-w-[180px] flex-1 flex-col">
              <span className="text-[15px] font-bold">{it.name}{it.label ? <span className="text-muted"> · {it.label}</span> : null}</span>
              <span className="text-[12.5px] text-subtle">{it.code}{it.shelfCode ? ` · Тавиур ${it.shelfCode}` : ''} · <Link href={`/warehouse/products/${it.productId}?variantId=${it.variantId}`} className="font-semibold text-accent-ink">Түүх</Link></span>
            </span>
            <span className="grid grid-cols-3 gap-3 text-center text-[12px] text-subtle">
              <span><span className="block text-[18px] font-extrabold text-ink">{it.demand}</span>захиалгад</span>
              <span><span className="block text-[18px] font-extrabold text-ink">{it.onShelf}</span>тавиурт</span>
              <span><span className="block text-[18px] font-extrabold text-bad-ink">{it.shortage}</span>дутуу</span>
            </span>
            <span className="flex w-full flex-wrap gap-1.5 text-[12.5px]">
              {it.incoming ? <span className="rounded-lg bg-info-soft px-2 py-1 font-semibold text-info">Замдаа ирж байна: {it.incoming}</span> : null}
              {it.sources.length ? it.sources.map((s) => <span key={s.warehouseId} className="rounded-lg bg-surface2 px-2 py-1 font-semibold">{s.name}: {s.qty}</span>)
                : <span className="rounded-lg bg-bad-soft px-2 py-1 font-semibold text-bad-ink">Бусад агуулахад байхгүй</span>}
              {it.uncovered > 0 && it.sources.length ? <span className="rounded-lg bg-bad-soft px-2 py-1 font-semibold text-bad-ink">Бүх агуулахаас ч {it.uncovered} дутна</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
