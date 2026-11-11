'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { Thumb } from '@/components/products/ProductsClient';
import { money, ubDateTime } from '@/lib/format';

/**
 * Агуулах: жолоочоос буцаалт хүлээн авах (Модуль 5). Жолооч сонгоход түүний гарт байгаа, хүргэлтэд хамааралгүй бүх бараа
 * (цуцалсан, маргааш болсон, болиулсан, нэмэлт) нэг жагсаалтаар — тоолж оруулаад «Хүлээн авсан». Дутуу нь жолоочид үлдэнэ.
 */
interface BRow { driverId: string; name: string; balance: number; held: number; returnable: number; lastReturnAt: string | null }
interface Item { variantId: number; code: string; name: string; label: string; thumb: string | null; shelfCode: string | null; balance: number; held: number; returnable: number }
interface Doc { id: number; kindLabel: string; at: string; byName: string; note: string | null; total: number; lines: { name: string; label: string; qty: number; expected: number }[] }
interface Detail { driver: { id: string; name: string }; canReceive: boolean; items: Item[]; totals: { balance: number; returnable: number }; docs: Doc[]; sources: { id: number; number: string; why: string; at: string | null }[] }

const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function ReturnsClient() {
  const [board, setBoard] = useState<{ canReceive: boolean; items: BRow[] } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [d, setD] = useState<Detail | null>(null);
  const [cnt, setCnt] = useState<Record<number, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const key = useRef(newKey());
  const loadBoard = useCallback(async () => { try { setBoard(await api('/api/returns')); } catch (e) { setErr(msg(e)); } }, []);
  const loadDetail = useCallback(async (id: string) => {
    try { const r = await api<Detail>(`/api/returns?driverId=${id}`); setD(r); setCnt(Object.fromEntries(r.items.filter((i) => i.returnable > 0).map((i) => [i.variantId, String(i.returnable)]))); setErr(null); }
    catch (e) { setErr(msg(e)); }
  }, []);
  useEffect(() => { void loadBoard(); }, [loadBoard]);
  useEffect(() => { if (sel) { key.current = newKey(); setNote(''); void loadDetail(sel); } else setD(null); }, [sel, loadDetail]);

  const rows = d?.items.filter((i) => i.returnable > 0) ?? [];
  const lines = rows.map((i) => ({ variantId: i.variantId, qty: Number(cnt[i.variantId] ?? 0) || 0 })).filter((l) => l.qty > 0);
  const short = rows.reduce((n, i) => n + Math.max(0, i.returnable - (Number(cnt[i.variantId] ?? 0) || 0)), 0);
  async function receive() {
    if (!d) return;
    setBusy(true); setErr(null);
    try {
      await api('/api/returns', { method: 'POST', json: { driverId: d.driver.id, lines, note, idemKey: key.current } });
      setFlash(`${d.driver.name}: ${lines.reduce((n, l) => n + l.qty, 0)} ширхэг хүлээн авлаа${short ? ` · дутуу ${short} жолоочид үлдсэн` : ''}`);
      key.current = newKey(); await Promise.all([loadBoard(), loadDetail(d.driver.id)]);
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/handover" className="inline-flex items-center gap-1 text-[13.5px] font-semibold text-muted hover:text-ink"><Icon name="left" size={15} />Падаан руу буцах</Link>
      </div>
      <div><h1 className="text-[24px] font-extrabold tracking-tight">Буцаалт хүлээн авах</h1><p className="text-[13.5px] text-muted">Цуцалсан, маргааш болсон, болиулсан, нэмэлт бараа — жолоочоос үндсэн агуулахад</p></div>
      {flash ? <div role="status" className="rounded-[12px] bg-ok-soft px-3 py-2 text-[14px] font-semibold text-ok-ink [overflow-wrap:anywhere]">{flash}</div> : null}
      {err ? <Notice>{err}</Notice> : null}
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <section className="flex flex-col gap-2">
          <h2 className="text-[13px] font-bold uppercase tracking-wide text-subtle">Бараатай жолооч</h2>
          {board && !board.items.length ? <p className="rounded-[14px] border border-dashed border-line px-4 py-8 text-center text-muted">Жолоочид бараа алга</p> : null}
          {board?.items.map((r) => (
            <button key={r.driverId} onClick={() => setSel(r.driverId)} className={clsx('flex items-center gap-3 rounded-[14px] border bg-surface px-3 py-2.5 text-left', sel === r.driverId ? 'border-accent ring-2 ring-accent/20' : 'border-line')}>
              <span className="min-w-0 flex-1"><b className="block [overflow-wrap:anywhere]">{r.name}</b><span className="text-[12px] text-subtle">Сүүлд: {r.lastReturnAt ? ubDateTime(r.lastReturnAt) : '—'}</span></span>
              <span className="text-right text-[12.5px]">{r.returnable ? <b className="block text-[16px] text-warn">{r.returnable}ш буцаах</b> : <span className="block text-subtle">буцаах 0</span>}{r.held ? <span className="text-info">хүргэлтэд {r.held}</span> : null}</span>
            </button>
          ))}
        </section>
        <section className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
          {!d ? <p className="rounded-[14px] border border-dashed border-line px-4 py-12 text-center text-muted">Жолооч сонгоно уу</p> : (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-[18px] font-extrabold [overflow-wrap:anywhere]">{d.driver.name}</h2><span className="text-[13px] text-muted">Гарт {d.totals.balance} · буцаах {d.totals.returnable}</span></div>
              {!rows.length ? <Notice tone="info">Буцаах бараа алга (хүргэлтэд явж буй бараа л байна)</Notice> : (
                <div className="overflow-x-auto rounded-[14px] border border-line bg-surface">
                  <table className="w-full min-w-[560px] text-[13.5px]">
                    <thead className="bg-surface2 text-left text-[12px] text-muted"><tr><th className="px-3 py-2">Бараа</th><th className="px-2 py-2">Тавиур</th><th className="px-2 py-2 text-right">Буцаах</th><th className="px-3 py-2 text-right">Ирсэн</th></tr></thead>
                    <tbody className="divide-y divide-line">
                      {rows.map((i) => {
                        const v = Number(cnt[i.variantId] ?? 0) || 0;
                        return (
                          <tr key={i.variantId} className={clsx(v < i.returnable && 'bg-warn-soft/40')}>
                            <td className="px-3 py-2"><div className="flex items-center gap-2"><Thumb src={i.thumb} alt={i.name} size={36} zoom={i.code} /><span className="min-w-0 [overflow-wrap:anywhere]"><b>{i.name}</b>{i.label ? ` · ${i.label}` : ''}<span className="block text-[12px] text-subtle">{i.code}</span></span></div></td>
                            <td className="px-2 py-2 font-semibold">{i.shelfCode ?? '—'}</td>
                            <td className="px-2 py-2 text-right font-bold">{i.returnable}</td>
                            <td className="px-3 py-2 text-right"><input inputMode="numeric" aria-label={`${i.name} ирсэн`} value={cnt[i.variantId] ?? ''} disabled={!d.canReceive}
                              onChange={(e) => setCnt((c) => ({ ...c, [i.variantId]: e.target.value.replace(/\D/g, '').slice(0, 5) }))}
                              className={clsx('h-10 w-16 rounded-lg border bg-surface text-center text-[15px] font-bold', v > i.returnable ? 'border-bad' : 'border-line')} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {rows.length && d.canReceive ? (
                <div className="flex flex-col gap-2">
                  {short ? <Notice tone="warn">Дутуу {short} ширхэг жолоочид «буцаагаагүй» гэж үлдэнэ (дараа буцаана / өр — нягтлан)</Notice> : null}
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Тэмдэглэл (заавал биш)" className="h-11 rounded-[10px] border border-line bg-surface px-3 text-[14px]" />
                  <Button variant="primary" size="lg" loading={busy} disabled={!lines.length || rows.some((i) => (Number(cnt[i.variantId] ?? 0) || 0) > i.returnable)} onClick={receive}>Хүлээн авсан ({lines.reduce((n, l) => n + l.qty, 0)}ш)</Button>
                </div>
              ) : null}
              {d.sources.length ? (
                <div className="rounded-[14px] border border-line bg-surface p-3 text-[13px]">
                  <b>Сүүлийн 7 хоногт яагаад:</b>
                  <p className="mt-1 text-muted [overflow-wrap:anywhere]">{d.sources.map((s) => `№${s.number} ${s.why}`).join(' · ')}</p>
                </div>
              ) : null}
              {d.docs.length ? (
                <div className="flex flex-col gap-1.5">
                  <h3 className="text-[14px] font-extrabold">Сүүлийн баримт</h3>
                  {d.docs.map((x) => (
                    <div key={x.id} className="rounded-[12px] border border-line bg-surface px-3 py-2 text-[13px]">
                      <div className="flex flex-wrap justify-between gap-2"><b>{x.kindLabel}</b><span className="text-subtle">{ubDateTime(x.at)} · {x.byName}</span></div>
                      <div className="text-muted [overflow-wrap:anywhere]">{x.lines.map((l) => `${l.name}${l.label ? ` · ${l.label}` : ''} ${l.qty}ш${l.expected > l.qty ? ` (дутуу ${l.expected - l.qty})` : ''}`).join(', ')}{x.total ? ` · ${money(x.total)}` : ''}{x.note ? ` · ${x.note}` : ''}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
