'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';
import { ubDateTime } from '@/lib/format';

/** #215 (эзэн): нийлүүлэгчид улаан мэдэгдэл бичих — нэг дэлгүүрт эсвэл бүгдэд; устгатал харагдана, хэн уншсаныг харна */
interface N { id: number; shopId: number | null; shopName: string | null; text: string; createdByName: string; createdAt: string; reads: { shopId: number; shopName: string; readAt: string }[]; readCount: number; target: number }
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');

export function SupplierNotices() {
  const [d, setD] = useState<{ shops: { id: number; name: string }[]; items: N[] } | null>(null);
  const [to, setTo] = useState('all');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => { try { setD(await api('/api/supplier/notices')); } catch (e) { setErr(msg(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  const post = async (json: Record<string, unknown>) => {
    setBusy(true); setErr(null);
    try { await api('/api/supplier/notices', { method: 'POST', json }); await load(); return true; } catch (e) { setErr(msg(e)); return false; } finally { setBusy(false); }
  };
  return (
    <section data-supplier-notices className="flex min-w-0 flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[16px] font-extrabold">📢 Нийлүүлэгчид мэдэгдэл{d?.items.length ? ` (${d.items.length})` : ''}</h2>
        <Button size="sm" onClick={() => setOpen(!open)}>{open ? 'Хураах' : '+ Мэдэгдэл бичих'}</Button>
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {open ? (
        <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
          <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Хэнд
            <select value={to} onChange={(e) => setTo(e.target.value)} className="h-10 rounded-lg border border-line bg-surface px-2 text-[14px] text-ink" data-notice-to>
              <option value="all">Бүх нийлүүлэгч</option>
              {d?.shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
          <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">Мэдэгдэл
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={1000} className="rounded-lg border border-line bg-surface p-2 text-[14px] text-ink" placeholder="Жишээ: Цагаан сарын хил хаалтаас өмнө бараагаа нөөцлөөрэй" data-notice-text /></label>
          <p className="text-[12px] text-subtle">Нийлүүлэгчид бүх хуудасны дээд талд улаан мэдэгдлээр харагдана — та «Устгах» дартал.</p>
          <Button variant="primary" size="sm" className="self-start" loading={busy} disabled={text.trim().length < 3} data-notice-send
            onClick={async () => { if (await post({ action: 'create', shopId: to, text })) { setText(''); setOpen(false); } }}>Илгээх</Button>
        </div>
      ) : null}
      {d?.items.length ? (
        <ul className="flex flex-col gap-2">
          {d.items.map((n) => (
            <li key={n.id} data-notice-item className="flex flex-wrap items-start gap-2 rounded-xl border border-bad/40 bg-bad-soft p-3 text-[13.5px]">
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-bold text-bad-ink">→ {n.shopName ?? 'Бүх нийлүүлэгч'} · {n.createdByName} · {ubDateTime(n.createdAt)}</div>
                <div className="whitespace-pre-wrap font-semibold [overflow-wrap:anywhere]">{n.text}</div>
                <div className="text-[12px] text-muted [overflow-wrap:anywhere]">Уншсан {n.readCount}/{n.target}{n.reads.length ? `: ${n.reads.map((r) => `${r.shopName} (${ubDateTime(r.readAt)})`).join(', ')}` : ''}</div>
              </div>
              <Button size="sm" variant="ghost" loading={busy} onClick={() => { if (confirm('Энэ мэдэгдлийг устгах уу? Нийлүүлэгчид харагдахаа болино.')) void post({ action: 'delete', id: n.id }); }}>Устгах</Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
