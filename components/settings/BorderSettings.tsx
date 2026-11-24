'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';

/** #214 (эзэн): Замын-Үүдийн хил хаагдах өдрүүд — гараар бичнэ; эхлэхээс N сарын (анх 1) өмнөөс улаан мэдэгдэл */
interface Item { name: string; from: string; to: string }
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
const inp = 'h-10 min-w-0 rounded-lg border border-line bg-surface px-2 text-[14px]';

export function BorderSettings() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [warnMonths, setWarnMonths] = useState('1');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ warnMonths: number; items: Item[] }>('/api/settings/border').then((r) => { setItems(r.items); setWarnMonths(String(r.warnMonths)); }).catch((e) => setErr(msg(e))); }, []);
  const save = async () => {
    setBusy(true); setErr(null); setOk(null);
    try { const r = await api<{ warnMonths: number; items: Item[] }>('/api/settings/border', { method: 'POST', json: { warnMonths: Number(warnMonths), items } }); setItems(r.items); setOk('Хадгалагдлаа'); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const set = (i: number, p: Partial<Item>) => setItems((xs) => xs!.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <section id="border" data-border-settings className="mt-4 flex min-w-0 flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
      <h2 className="text-[16px] font-extrabold">🚧 Замын-Үүдийн хил хаагдах өдрүүд</h2>
      <p className="text-[13px] text-subtle">Хил хаагдах өдрүүдийг гараар бичнэ (жишээ нь Цагаан сар). Хаалт эхлэх өдрөөс доорх сарын өмнөөс (жишээ 2/6 → 1/6) хаалт дуустал Супер админ, Бараа захиалгын ажилтан, Нийлүүлэгч нарт бүх хуудасны дээд талд улаан мэдэгдэл гарна.</p>
      {err ? <Notice>{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
      <label className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold">Хаалт эхлэхээс
        <input value={warnMonths} onChange={(e) => setWarnMonths(e.target.value.replace(/\D/g, '').slice(0, 1))} inputMode="numeric" aria-label="Хэдэн сарын өмнөөс" className={`${inp} w-16 text-right`} />
        сарын өмнөөс мэдэгдэнэ</label>
      {items ? (
        <div className="flex flex-col gap-2">
          {items.map((x, i) => (
            <div key={i} data-border-row className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-2">
              <input value={x.name} onChange={(e) => set(i, { name: e.target.value })} maxLength={60} placeholder="Нэр (Цагаан сар)" aria-label="Нэр" className={`${inp} flex-[1_1_160px]`} />
              <label className="flex items-center gap-1 text-[12.5px] text-muted">Эхлэх<input type="date" value={x.from} onChange={(e) => set(i, { from: e.target.value })} aria-label="Эхлэх өдөр" className={inp} /></label>
              <label className="flex items-center gap-1 text-[12.5px] text-muted">Дуусах<input type="date" value={x.to} onChange={(e) => set(i, { to: e.target.value })} aria-label="Дуусах өдөр" className={inp} /></label>
              <Button size="sm" variant="ghost" onClick={() => setItems(items.filter((_, j) => j !== i))}>Устгах</Button>
            </div>
          ))}
          {!items.length ? <p className="text-[13px] text-muted">Хил хаалт бүртгээгүй байна.</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" data-border-add onClick={() => setItems([...items, { name: '', from: '', to: '' }])}>+ Хаалт нэмэх</Button>
            <Button size="sm" variant="primary" loading={busy} data-border-save onClick={() => void save()}>Хадгалах</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
