'use client';
import clsx from 'clsx';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';

export interface ExtrasItem {
  driverId: string; driverName: string; taken: number; toReturn: number;
  open: { docs: number; pieces: number; amount: number; fee: number; receive: number; rate: number | null; lines: { id: number; at: string; pieces: number; amount: number; payment: string | null; fee: number }[] };
  settled: { pieces: number; amount: number; fee: number; receive: number; byName: string | null };
}
export interface ExtrasDay {
  date: string; items: ExtrasItem[];
  totals: { taken: number; openPieces: number; openAmount: number; openFee: number; openReceive: number; settledAmount: number; settledFee: number; settledReceive: number; toReturn: number };
}
const PAY: Record<string, string> = { CASH: 'Бэлэн', BANK: 'Данс', UNPAID: 'Төлөөгүй' };
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');

/**
 * #175 Нэмэлт барааны ТУСДАА тооцоо — жолоочийн өдрийн тооцоонд нийлэхгүй. Жолооч дээр дарахгүйгээр, жолооч хүсэлт илгээгээгүй ч харагдана.
 * Авах = зарсан дүн − хөлс (ширхэг × тэр өдрийн 1 хүргэлтийн хөлс).
 */
export function ExtrasSection({ d, onDone, onErr, onOk }: { d: ExtrasDay; onDone: () => void; onErr: (s: string) => void; onOk: (s: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (!d.items.length) return null;
  const settle = async (x: ExtrasItem) => {
    if (!confirm(`${x.driverName}: нэмэлт бараа ${x.open.pieces}ш · ${money(x.open.amount)} − хөлс ${money(x.open.fee)} = ${money(x.open.receive)} авсан уу?`)) return;
    setBusy(x.driverId);
    try {
      const r = await api<{ receive: number; pieces: number }>('/api/accounting/extras', { method: 'POST', json: { driverId: x.driverId, date: d.date } });
      onOk(`${x.driverName}: нэмэлт барааны ${money(r.receive)} авлаа (${r.pieces}ш)`); onDone();
    } catch (e) { onErr(msg(e)); } finally { setBusy(null); }
  };
  const t = d.totals;
  return (
    <section data-extras className="overflow-hidden rounded-[20px] border border-line bg-surface shadow-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[16px] font-extrabold">Нэмэлт бараа <span className="text-[12.5px] font-semibold text-subtle">· тусдаа тооцоо (өдрийн тооцоонд ордоггүй)</span></h2>
          <p className="text-[12.5px] text-muted">Авах = зарсан − хөлс (ширхэг бүрт тэр өдрийн 1 хүргэлтийн хөлс). Зараагүй, буцаагаагүй нь бүтэн үнээр өр.</p>
        </div>
        <div className="text-right">
          <div className="text-[12px] font-semibold text-muted">Авах (тушаагаагүй)</div>
          <div data-extras-total className="text-[22px] font-extrabold">{money(t.openReceive)}</div>
          {t.settledReceive ? <div className="text-[12px] text-ok-ink">Өнөөдөр авсан {money(t.settledReceive)}</div> : null}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead className="text-[12px] text-subtle"><tr className="border-b border-line">
            <th className="px-4 py-2 text-left font-semibold">Жолооч</th><th className="px-3 py-2 text-right font-semibold">Авсан</th><th className="px-3 py-2 text-right font-semibold">Зарсан</th>
            <th className="px-3 py-2 text-right font-semibold">Буцаах</th><th className="px-3 py-2 text-right font-semibold">Хөлс</th><th className="px-3 py-2 text-right font-semibold">Авах</th><th className="px-4 py-2" />
          </tr></thead>
          <tbody>
            {d.items.map((x) => (
              <tr key={x.driverId} data-extras-row={x.driverId} className="border-b border-line align-top last:border-0">
                <td className="max-w-[260px] px-4 py-2.5">
                  <b className="[overflow-wrap:anywhere]">{x.driverName}</b>
                  {x.open.lines.length ? <button type="button" onClick={() => setOpen(open === x.driverId ? null : x.driverId)} className="block text-[12px] font-semibold text-accent-ink">{open === x.driverId ? '▾' : '▸'} {x.open.docs} баримт</button> : null}
                  {open === x.driverId ? (
                    <ul className="mt-1 space-y-0.5 text-[12px] text-muted">
                      {x.open.lines.map((l) => <li key={l.id}>{ubDateTime(l.at)} · {l.pieces}ш · {money(l.amount)}{l.payment ? ` · ${PAY[l.payment] ?? l.payment}` : ''} · хөлс {money(l.fee)}</li>)}
                    </ul>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 text-right">{x.taken ? `${x.taken}ш` : '—'}</td>
                <td className="px-3 py-2.5 text-right whitespace-nowrap">{x.open.pieces ? <><b>{x.open.pieces}ш</b><div className="text-[12px] text-subtle">{money(x.open.amount)}</div></> : '—'}</td>
                <td className={clsx('px-3 py-2.5 text-right', x.toReturn && 'font-bold text-warn')}>{x.toReturn ? `${x.toReturn}ш` : '—'}</td>
                <td className="px-3 py-2.5 text-right whitespace-nowrap">{x.open.pieces ? <>{money(x.open.fee)}{x.open.rate ? <div className="text-[12px] text-subtle">{money(x.open.rate)} × {x.open.pieces}</div> : null}</> : '—'}</td>
                <td className="px-3 py-2.5 text-right text-[14.5px] font-extrabold whitespace-nowrap">{x.open.pieces ? money(x.open.receive) : '—'}</td>
                <td className="px-4 py-2.5 text-right">
                  {x.open.pieces ? <Button size="sm" variant="primary" data-extras-settle loading={busy === x.driverId} onClick={() => void settle(x)}>Нэмэлтийн мөнгө авсан</Button> : null}
                  {x.settled.pieces ? <div className="mt-1 text-[12px] font-semibold text-ok-ink">✓ Авсан {money(x.settled.receive)}<span className="block font-normal text-subtle">{x.settled.pieces}ш · хөлс {money(x.settled.fee)}{x.settled.byName ? ` · ${x.settled.byName}` : ''}</span></div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
