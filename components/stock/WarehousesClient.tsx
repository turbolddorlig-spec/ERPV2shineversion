'use client';
import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Notice';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';

interface Wh { id: number; name: string; address: string | null; isPrimary: boolean; isActive: boolean }

/** Агуулахууд (#38): 6 агуулах, 1 үндсэн. Удирдах — Супер админ / Админ. */
export function WarehousesClient({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const [items, setItems] = useState<Wh[]>([]);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [edit, setEdit] = useState<Record<number, { name: string; address: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ items: Wh[] }>('/api/stock/warehouses?all=1').then((r) => setItems(r.items)), []);
  useEffect(() => { load().catch(() => undefined); }, [load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setError(null); setFlash(null); setBusy(true);
    try { await fn(); setFlash(ok); await load(); router.refresh(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Алдаа'); } finally { setBusy(false); }
  }
  const patch = (id: number, json: unknown) => api(`/api/stock/warehouses/${id}`, { method: 'PATCH', json });

  return (
    <div className="flex max-w-[860px] flex-col gap-4">
      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}
      {canManage ? (
        <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field id="w-name" label="Шинэ агуулахын нэр" value={name} onChange={(e) => setName(e.target.value)} placeholder="Жишээ: Агуулах 4" />
          <Field id="w-addr" label="Хаяг (заавал биш)" value={address} onChange={(e) => setAddress(e.target.value)} />
          <Button variant="primary" loading={busy} disabled={name.trim().length < 2}
            onClick={() => run(async () => { await api('/api/stock/warehouses', { method: 'POST', json: { name, address } }); setName(''); setAddress(''); }, 'Агуулах нэмэгдлээ')}>
            <Icon name="plus" size={16} />Нэмэх
          </Button>
        </section>
      ) : null}
      <ul className="flex flex-col gap-2">
        {items.map((w) => {
          const e = edit[w.id];
          return (
            <li key={w.id} className={clsx('flex flex-wrap items-center gap-3 rounded-[16px] border bg-surface p-3.5 shadow-card', w.isPrimary ? 'border-accent' : 'border-line', !w.isActive && 'opacity-60')}>
              {e ? (
                <div className="grid flex-1 gap-2 sm:grid-cols-2">
                  <Field id={`n${w.id}`} label="Нэр" value={e.name} onChange={(x) => setEdit((s) => ({ ...s, [w.id]: { ...e, name: x.target.value } }))} />
                  <Field id={`a${w.id}`} label="Хаяг" value={e.address} onChange={(x) => setEdit((s) => ({ ...s, [w.id]: { ...e, address: x.target.value } }))} />
                </div>
              ) : (
                <span className="flex flex-1 flex-col">
                  <span className="flex items-center gap-2 text-[16px] font-bold">{w.name}{w.isPrimary ? <Badge tone="accent">★ Үндсэн</Badge> : null}{!w.isActive ? <Badge tone="neutral">Хаагдсан</Badge> : null}</span>
                  {w.address ? <span className="text-[13px] text-muted">{w.address}</span> : null}
                </span>
              )}
              {canManage ? (
                <span className="flex flex-wrap gap-1.5">
                  {e ? (
                    <>
                      <Button size="sm" onClick={() => setEdit((s) => { const n = { ...s }; delete n[w.id]; return n; })}>Болих</Button>
                      <Button size="sm" variant="primary" loading={busy} onClick={() => run(async () => { await patch(w.id, e); setEdit((s) => { const n = { ...s }; delete n[w.id]; return n; }); }, 'Хадгаллаа')}>Хадгалах</Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" onClick={() => setEdit((s) => ({ ...s, [w.id]: { name: w.name, address: w.address ?? '' } }))}><Icon name="edit" size={14} />Засах</Button>
                      {!w.isPrimary && w.isActive ? <Button size="sm" loading={busy} onClick={() => run(() => patch(w.id, { isPrimary: true }), `«${w.name}» үндсэн агуулах боллоо`)}>Үндсэн болгох</Button> : null}
                      {!w.isPrimary ? (w.isActive
                        ? <Button size="sm" variant="danger" loading={busy} onClick={() => run(() => patch(w.id, { isActive: false }), `«${w.name}» хаагдлаа`)}>Хаах</Button>
                        : <Button size="sm" loading={busy} onClick={() => run(() => patch(w.id, { isActive: true }), `«${w.name}» нээгдлээ`)}>Нээх</Button>) : null}
                    </>
                  )}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="text-[12.5px] text-subtle">Захиалга, дүүргэлт үндсэн агуулахын тавиураар тооцогдоно. Үлдэгдэлтэй агуулахыг хаахгүй — эхлээд шилжүүлнэ.</p>
    </div>
  );
}
