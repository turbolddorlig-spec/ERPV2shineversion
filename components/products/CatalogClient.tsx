'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';
import { CATEGORY_DOT } from '@/lib/format';

interface Item { id: number; name: string; color: string; isActive: boolean; productCount: number }
const COLORS = Object.keys(CATEGORY_DOT);

export function CatalogClient({ kind, title }: { kind: 'categories' | 'seasons'; title: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [name, setName] = useState('');
  const [color, setColor] = useState('orange');
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setItems((await api<{ items: Item[] }>(`/api/catalog/${kind}`)).items); } catch (e) { setError(e instanceof ApiError ? e.message : 'Алдаа'); }
  }, [kind]);
  useEffect(() => { load(); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError(e instanceof ApiError ? e.message : 'Алдаа'); } finally { setBusy(false); }
  }

  return (
    <section className="flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-5 shadow-card">
      <h2 className="text-[16px] font-extrabold">{title}</h2>
      {error ? <Notice>{error}</Notice> : null}
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) run(async () => { await api(`/api/catalog/${kind}`, { method: 'POST', json: { name, color } }); setName(''); }); }}>
        <label className="flex min-w-0 flex-[1_1_180px] flex-col gap-1 text-[13px] font-semibold text-muted">
          Шинэ {title.toLowerCase()}
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="h-11 rounded-xl border border-line bg-surface px-3 text-ink outline-none focus:border-accent" />
        </label>
        {kind === 'categories' ? (
          <div role="radiogroup" aria-label="Өнгө" className="flex gap-1">
            {COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} onClick={() => setColor(c)}
                className={clsx('h-9 w-9 rounded-lg border-2', color === c ? 'border-ink' : 'border-transparent')} style={{ background: CATEGORY_DOT[c] }} />
            ))}
          </div>
        ) : null}
        <Button type="submit" variant="primary" loading={busy}>Нэмэх</Button>
      </form>
      <ul className="flex flex-col divide-y divide-line">
        {items.map((it) => (
          <li key={it.id} className={clsx('flex flex-wrap items-center gap-2 py-2.5', !it.isActive && 'opacity-55')}>
            {kind === 'categories' ? <span aria-hidden="true" className="h-3 w-3 rounded-[4px]" style={{ background: CATEGORY_DOT[it.color] }} /> : null}
            {editing?.id === it.id ? (
              <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/api/catalog/${kind}/${it.id}`, { method: 'PATCH', json: { name: editing.name } }); setEditing(null); }); }}>
                <input aria-label="Нэр" value={editing.name} onChange={(e) => setEditing({ id: it.id, name: e.target.value })} className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-ink" />
                <Button size="sm" type="submit" variant="dark">Хадгалах</Button>
                <Button size="sm" onClick={() => setEditing(null)}>Болих</Button>
              </form>
            ) : (
              <>
                <span className="flex-1 font-semibold">{it.name} <span className="text-[12.5px] font-normal text-subtle">· {it.productCount} бараа</span></span>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ id: it.id, name: it.name })}>Нэр солих</Button>
                <Button size="sm" onClick={() => run(() => api(`/api/catalog/${kind}/${it.id}`, { method: 'PATCH', json: { isActive: !it.isActive } }))}>{it.isActive ? 'Нуух' : 'Сэргээх'}</Button>
              </>
            )}
          </li>
        ))}
        {items.length === 0 ? <li className="py-4 text-center text-muted">Алга</li> : null}
      </ul>
    </section>
  );
}
