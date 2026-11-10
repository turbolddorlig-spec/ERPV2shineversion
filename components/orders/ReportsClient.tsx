'use client';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { Notice } from '@/components/ui/Notice';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';
import { ubDateTime } from '@/lib/format';
import { formatPhone } from '@/lib/phone';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const chip = (on: boolean) => clsx('inline-flex h-10 shrink-0 items-center rounded-full border px-3.5 text-[13.5px] font-semibold', on ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-ink');
const sec = 'flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card';
const ymd = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

interface PRow { key: string; label: string; created: number; confirmed: number; cancelled: number; delivered: number }
interface CallResp { from: string; to: string; total: number; converted: number; buckets: { key: string; label: string; n: number; pct: number }[]; by: string | null; table: ({ key: string } & Record<string, number | string>)[]; phones: { phone: string; product: string | null; page: string | null; operator: string; createdAt: string }[]; labels: Record<string, string> }

export function ReportsClient() {
  const [tab, setTab] = useState<'pages' | 'calls'>('pages');
  const [from, setFrom] = useState(() => ymd(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(() => ymd(new Date()));
  const [pageId, setPageId] = useState('');
  const [pages, setPages] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => { api<{ pages: { id: number; name: string }[] }>('/api/orders/pages').then((r) => setPages(r.pages)).catch(() => undefined); }, []);
  const quick = (days: number) => { setFrom(ymd(new Date(Date.now() - (days - 1) * 86_400_000))); setTo(ymd(new Date())); };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <button type="button" className={chip(tab === 'pages')} aria-pressed={tab === 'pages'} onClick={() => setTab('pages')}>Пэйжийн тайлан</button>
        <button type="button" className={chip(tab === 'calls')} aria-pressed={tab === 'calls'} onClick={() => setTab('calls')}>Дуудлагын шинжилгээ</button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Эхлэх<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-11 rounded-xl border border-line bg-surface px-3 text-ink" /></label>
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Дуусах<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-11 rounded-xl border border-line bg-surface px-3 text-ink" /></label>
        <button type="button" className={chip(false)} onClick={() => quick(1)}>Өнөөдөр</button>
        <button type="button" className={chip(false)} onClick={() => quick(7)}>7 хоног</button>
        <button type="button" className={chip(false)} onClick={() => quick(30)}>30 хоног</button>
        {tab === 'pages' ? (
          <select aria-label="Пэйж" value={pageId} onChange={(e) => setPageId(e.target.value)} className="h-11 rounded-xl border border-line bg-surface px-3">
            <option value="">Бүх пэйж</option>
            {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        ) : null}
      </div>
      {tab === 'pages' ? <PagesReport from={from} to={to} pageId={pageId} /> : <CallsReport from={from} to={to} />}
    </div>
  );
}

function Excel({ href }: { href: string }) {
  return <a href={href} className="ml-auto inline-flex h-10 items-center gap-1.5 rounded-[11px] border border-line bg-surface px-3.5 text-[13.5px] font-semibold"><Icon name="download" size={16} />Excel</a>;
}

function PagesReport({ from, to, pageId }: { from: string; to: string; pageId: string }) {
  const [by, setBy] = useState('page');
  const [rows, setRows] = useState<{ rows: PRow[]; total: Omit<PRow, 'key' | 'label'> } | null>(null);
  const [products, setProducts] = useState<{ code: string; name: string; label: string; qty: number; orders: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    const sp = new URLSearchParams({ from, to, by, ...(pageId ? { pageId } : {}) });
    if (by === 'product') api<{ products: NonNullable<typeof products> }>(`/api/reports/pages?${sp}`).then((r) => { setProducts(r.products); setRows(null); }).catch((e) => setError(msg(e)));
    else api<NonNullable<typeof rows>>(`/api/reports/pages?${sp}`).then((r) => { setRows(r); setProducts(null); }).catch((e) => setError(msg(e)));
  }, [from, to, by, pageId]);
  const sp = new URLSearchParams({ kind: 'pages', from, to, by, ...(pageId ? { pageId } : {}) });
  const th = 'px-2 py-2 text-right font-semibold';
  return (
    <section className={sec}>
      <div className="flex flex-wrap items-center gap-2">
        {[['page', 'Пэйжээр'], ['operator', 'Оператороор'], ['day', 'Өдрөөр'], ['product', 'Бараагаар']].map(([v, l]) => <button key={v} type="button" className={chip(by === v)} aria-pressed={by === v} onClick={() => setBy(v)}>{l}</button>)}
        <Excel href={`/api/reports/export?${sp}`} />
      </div>
      <p className="text-[12.5px] text-subtle">Зөвхөн тоо. Захиалга — үүссэн өдрөөр; Баталгаажсан — мөнгө орсон / шинэ болсон өдрөөр; Цуцлагдсан, Хүргэсэн — тухайн үйлдлийн өдрөөр.</p>
      {error ? <Notice>{error}</Notice> : null}
      {rows ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-[14px]">
            <thead className="border-b border-line text-muted"><tr><th className="px-2 py-2 text-left font-semibold">{by === 'operator' ? 'Оператор' : by === 'day' ? 'Өдөр' : 'Пэйж'}</th><th className={th}>Захиалга</th><th className={th}>Баталгаажсан</th><th className={th}>Цуцлагдсан</th><th className={th}>Хүргэсэн</th></tr></thead>
            <tbody className="divide-y divide-line">
              {rows.rows.map((r) => <tr key={r.key}><td className="px-2 py-2 font-semibold">{r.label}</td><td className="px-2 text-right">{r.created}</td><td className="px-2 text-right font-bold">{r.confirmed}</td><td className="px-2 text-right text-bad-ink">{r.cancelled}</td><td className="px-2 text-right text-ok-ink">{r.delivered}</td></tr>)}
              {!rows.rows.length ? <tr><td colSpan={5} className="py-6 text-center text-muted">Мэдээлэл алга</td></tr> : null}
            </tbody>
            <tfoot className="border-t-2 border-line font-extrabold"><tr><td className="px-2 py-2">Нийт</td><td className="px-2 text-right">{rows.total.created}</td><td className="px-2 text-right">{rows.total.confirmed}</td><td className="px-2 text-right">{rows.total.cancelled}</td><td className="px-2 text-right">{rows.total.delivered}</td></tr></tfoot>
          </table>
        </div>
      ) : products ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-[14px]">
            <thead className="border-b border-line text-muted"><tr><th className="px-2 py-2 text-left font-semibold">Бараа</th><th className={th}>Ширхэг</th><th className={th}>Захиалга</th></tr></thead>
            <tbody className="divide-y divide-line">
              {products.map((p) => <tr key={p.code}><td className="px-2 py-2"><span className="font-semibold">{p.name}</span>{p.label ? <span className="text-muted"> · {p.label}</span> : null} <span className="text-[12px] text-subtle">{p.code}</span></td><td className="px-2 text-right font-bold">{p.qty}</td><td className="px-2 text-right">{p.orders}</td></tr>)}
              {!products.length ? <tr><td colSpan={3} className="py-6 text-center text-muted">Мэдээлэл алга</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : <p className="text-muted">Ачаалж байна…</p>}
    </section>
  );
}

function CallsReport({ from, to }: { from: string; to: string }) {
  const [by, setBy] = useState('');
  const [bucket, setBucket] = useState('');
  const [d, setD] = useState<CallResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    const sp = new URLSearchParams({ from, to, ...(by ? { by } : {}), ...(bucket ? { bucket } : {}) });
    api<CallResp>(`/api/reports/calls?${sp}`).then(setD).catch((e) => setError(msg(e)));
  }, [from, to, by, bucket]);
  const sp = new URLSearchParams({ kind: 'calls', from, to, ...(by ? { by } : {}), ...(bucket ? { bucket } : {}) });
  const cols = d ? d.buckets.map((b) => b.key) : [];
  return (
    <section className={sec}>
      {error ? <Notice>{error}</Notice> : null}
      {!d ? <p className="text-muted">Ачаалж байна…</p> : (
        <>
          <div className="flex flex-wrap items-baseline gap-3">
            <p className="text-[15px]"><b className="text-[22px]">{d.total}</b> дугаар тэмдэглэгдсэн · <b className="text-ok-ink">{d.converted}</b> захиалга болсон ({d.total ? Math.round((d.converted / d.total) * 100) : 0}%)</p>
            <Excel href={`/api/reports/export?${sp}`} />
          </div>
          <p className="text-[12.5px] text-subtle">Мөр дээр дарж тухайн шалтгаантай дугааруудыг харна. «Шалтгаангүй» — 3 хоногоос дээш хаагдаагүй.</p>
          <ul className="flex flex-col gap-1.5">
            {d.buckets.map((b) => (
              <li key={b.key}>
                <button type="button" aria-pressed={bucket === b.key} onClick={() => setBucket(bucket === b.key ? '' : b.key)} className={clsx('relative flex w-full items-center gap-3 overflow-hidden rounded-xl border px-3 py-2.5 text-left', bucket === b.key ? 'border-ink' : 'border-line')}>
                  <span aria-hidden className={clsx('absolute inset-y-0 left-0', b.key === 'CONVERTED' ? 'bg-ok-soft' : 'bg-surface2')} style={{ width: `${b.pct}%` }} />
                  <span className="relative flex-1 font-semibold">{b.label}</span>
                  <span className="relative font-extrabold">{b.n}</span>
                  <span className="relative w-14 text-right text-muted">{b.pct}%</span>
                </button>
              </li>
            ))}
          </ul>
          {bucket && d.phones.length ? (
            <div className="rounded-xl bg-surface2 p-3">
              <p className="mb-2 font-bold">{d.labels[bucket] ?? bucket} — {d.phones.length} дугаар</p>
              <ul className="flex max-h-[360px] flex-col gap-1 overflow-auto text-[13.5px]">
                {d.phones.map((x, i) => <li key={i} className="flex flex-wrap gap-x-3"><a href={`tel:${x.phone}`} className="select-text font-bold">{formatPhone(x.phone)}</a><span>{x.product ?? '—'}</span><span className="text-subtle">{x.page ?? ''} · {x.operator} · {ubDateTime(x.createdAt)}</span></li>)}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <span className="text-[13px] font-semibold text-muted">Задлах:</span>
            {[['', 'Үгүй'], ['page', 'Пэйжээр'], ['product', 'Бараагаар'], ['operator', 'Оператороор']].map(([v, l]) => <button key={v} type="button" className={chip(by === v)} aria-pressed={by === v} onClick={() => setBy(v)}>{l}</button>)}
          </div>
          {by && d.table.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[13px]">
                <thead className="border-b border-line text-muted"><tr><th className="px-2 py-2 text-left">{by === 'page' ? 'Пэйж' : by === 'product' ? 'Бараа' : 'Оператор'}</th><th className="px-2 text-right">Нийт</th>{cols.map((c) => <th key={c} className="px-2 text-right">{d.labels[c] ?? c}</th>)}</tr></thead>
                <tbody className="divide-y divide-line">
                  {d.table.map((r) => <tr key={r.key}><td className="px-2 py-1.5 font-semibold">{r.key}</td><td className="px-2 text-right font-bold">{r.total}</td>{cols.map((c) => <td key={c} className={clsx('px-2 text-right', c === 'CONVERTED' && 'text-ok-ink')}>{r[c] ?? ''}</td>)}</tr>)}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
