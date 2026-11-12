'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Badge } from '@/components/ui/Badge';
import { api, ApiError } from '@/components/ui/api';
import { money, ubDateTime } from '@/lib/format';

/**
 * Алдаа удирдлага (Модуль 7а, хуучин ERP шиг): картууд, шүүлт, торгуулийн жагсаалт, «Торгууль нэмэх» (алдааны нэр — хэрэглэгч шинээр үүсгэнэ),
 * «Цалингаас хассан», шалтгаантай «Цуцлах», «Ажилчдын мэдээлэл» (торгууль + барааны зээл).
 */
export interface PenaltyRow {
  id: number; type: string; typeLabel: string; category: string; amount: number; description: string | null; userId: string; userName: string;
  orderNumber: string | null; pageName: string | null; customerPhone: string | null; customerName: string | null; auto: boolean;
  createdByName: string; createdAt: string; status: string; deductedAmount: number; cancelledByName: string | null; cancelNote: string | null; deducted: boolean; deductedAt: string | null; deductedByName: string | null;
}
export type Summary = { total: number; count: number; pending: number; deducted: number; cancelled: number; byType: Record<string, { count: number; amount: number }> };
interface Staff { id: string; name: string; phone: string; roles: string[]; defaultType: string | null }
interface ListResp { page: number; total: number; pages: number; summary: Summary; canManage: boolean; canDeduct: boolean; canCancel?: boolean; items: PenaltyRow[]; staff: Staff[] }
interface Cat { id: string; type: string; name: string; defaultAmount: number; active: boolean; lateMinutes?: boolean }
interface Config { autoAmount: Record<string, number>; categories: Cat[]; types: { type: string; label: string }[]; canManage: boolean; canAutoAmount: boolean }

export const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');
export const TYPE_TONE: Record<string, string> = { OPP_ERROR: 'bg-info', DELIVERY_ERROR: 'bg-warn', MARKETING_ERROR: 'bg-accent', WAREHOUSE_ERROR: 'bg-ok' };
const TYPE_SHORT: Record<string, string> = { OPP_ERROR: 'Опп', DELIVERY_ERROR: 'Хүргэлт', MARKETING_ERROR: 'Маркетинг', WAREHOUSE_ERROR: 'Агуулах' };
const monthStart = () => { const d = new Date(Date.now() + 8 * 3600_000); return `${d.toISOString().slice(0, 8)}01`; };
const ubToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

export function StatusBadge({ p }: { p: PenaltyRow }) {
  if (p.status === 'CANCELLED') return <Badge>Цуцлагдсан</Badge>;
  if (p.deducted) return <Badge tone="ok">Цалингаас хассан</Badge>;
  if (p.deductedAmount > 0) return <Badge tone="warn">Хэсэгчлэн хассан · үлд. {money(p.amount - p.deductedAmount)}</Badge>;
  return <Badge tone="bad">Хасагдаагүй</Badge>;
}

export function PenaltiesClient() {
  const [tab, setTab] = useState<'list' | 'staff'>('list');
  const [f, setF] = useState({ from: monthStart(), to: ubToday(), type: '', userId: '', status: '' });
  const [page, setPage] = useState(1);
  const [d, setD] = useState<ListResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [add, setAdd] = useState(false);
  const [cats, setCats] = useState(false);
  const [cancel, setCancel] = useState<PenaltyRow | null>(null);
  const load = useCallback(async () => {
    try { setD(await api(`/api/penalties?${new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page: String(page) })}`)); setErr(null); } catch (e) { setErr(msg(e)); }
  }, [f, page]);
  useEffect(() => { void load(); }, [load]);
  const deduct = async (p: PenaltyRow) => {
    if (!window.confirm(`${p.userName}: ${money(p.amount)} торгуулийг цалингаас хассан гэж тэмдэглэх үү?`)) return;
    try { await api(`/api/penalties/${p.id}/deduct`, { method: 'POST' }); await load(); } catch (e) { setErr(msg(e)); }
  };
  const s = d?.summary;
  const set = (k: keyof typeof f, v: string) => { setF({ ...f, [k]: v }); setPage(1); };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0"><h1 className="text-[24px] font-extrabold tracking-tight">Алдаа удирдлага</h1><p className="text-[13.5px] text-muted">Торгуулийн бүртгэл, алдааны тооцоо</p></div>
        {d?.canManage ? <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => setCats(true)}>Алдааны нэрс</Button><Button size="sm" variant="primary" onClick={() => setAdd(true)}>+ Торгууль нэмэх</Button></div> : null}
      </div>
      <div className="flex gap-1 rounded-[14px] bg-surface2 p-1 sm:w-fit" role="tablist">
        {([['list', 'Торгууль'], ['staff', 'Ажилчдын мэдээлэл']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={clsx('h-10 flex-1 rounded-[11px] px-4 text-[13.5px] font-bold sm:flex-none', tab === k ? 'bg-surface text-ink shadow-card' : 'text-muted')}>{l}</button>
        ))}
      </div>
      {err ? <Notice>{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}

      {tab === 'staff' ? <StaffInfo staff={d?.staff ?? []} /> : (
        <>
          {s ? (
            <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div><div className="text-[13px] font-semibold text-muted">Нийт торгууль ({s.count})</div><div className="text-[30px] font-extrabold leading-tight">{money(s.total)}</div>
                  <div className="text-[13px] text-muted">Хасагдаагүй <b className="text-bad-ink">{money(s.pending)}</b> · Цалингаас хассан <b className="text-ok-ink">{money(s.deducted)}</b>{s.cancelled ? ` · цуцлагдсан ${s.cancelled}` : ''}</div></div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
                {Object.entries(s.byType).map(([t, v]) => (
                  <button key={t} onClick={() => set('type', f.type === t ? '' : t)} className={clsx('min-w-0 rounded-[12px] px-3 py-2 text-left', f.type === t ? 'bg-ink text-on-ink' : 'bg-surface2')}>
                    <div className="flex items-center gap-1.5 text-[12px] font-semibold"><span className={clsx('h-2 w-2 rounded-full', TYPE_TONE[t])} />{TYPE_SHORT[t]} алдаа</div>
                    <div className="truncate text-[18px] font-extrabold">{money(v.amount)}</div><div className="text-[12px] opacity-70">{v.count} удаа</div>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} className="h-10 rounded-[10px] border border-line bg-surface px-2 text-[13.5px]" aria-label="Эхлэх огноо" />
            <span className="text-muted">–</span>
            <input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} className="h-10 rounded-[10px] border border-line bg-surface px-2 text-[13.5px]" aria-label="Дуусах огноо" />
            <select value={f.userId} onChange={(e) => set('userId', e.target.value)} className="h-10 max-w-[220px] rounded-[10px] border border-line bg-surface px-2 text-[13.5px]" aria-label="Ажилтан">
              <option value="">Бүх ажилтан</option>{d?.staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <select value={f.status} onChange={(e) => set('status', e.target.value)} className="h-10 rounded-[10px] border border-line bg-surface px-2 text-[13.5px]" aria-label="Төлөв">
              <option value="">Бүх төлөв</option><option value="PENDING">Хасагдаагүй</option><option value="DEDUCTED">Цалингаас хассан</option><option value="CANCELLED">Цуцлагдсан</option>
            </select>
          </div>
          <PenaltyList items={d?.items ?? []} showUser canManage={!!d?.canCancel} canDeduct={!!d?.canDeduct} onDeduct={deduct} onCancel={setCancel} />
          {d && d.pages > 1 ? (
            <div className="flex items-center justify-end gap-2 text-[13px]"><span className="text-muted">{d.total} торгууль</span><Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</Button><span>{page} / {d.pages}</span><Button size="sm" disabled={page >= d.pages} onClick={() => setPage(page + 1)}>›</Button></div>
          ) : null}
        </>
      )}
      {add && d ? <AddDialog staff={d.staff} onClose={() => setAdd(false)} onDone={async (m) => { setAdd(false); setOk(m); await load(); }} /> : null}
      {cats ? <CategoriesDialog onClose={() => setCats(false)} /> : null}
      {cancel ? <CancelDialog p={cancel} onClose={() => setCancel(null)} onDone={async () => { setCancel(null); await load(); }} /> : null}
    </div>
  );
}

export function PenaltyList({ items, showUser, canManage, canDeduct, onDeduct, onCancel }: { items: PenaltyRow[]; showUser?: boolean; canManage?: boolean; canDeduct?: boolean; onDeduct?: (p: PenaltyRow) => void; onCancel?: (p: PenaltyRow) => void }) {
  return (
    <section className="overflow-hidden rounded-[20px] border border-line bg-surface shadow-card">
      <ul className="divide-y divide-line">
        {items.map((p) => (
          <li key={p.id} className={clsx('flex flex-wrap items-start gap-x-4 gap-y-1.5 px-4 py-3', p.status === 'CANCELLED' && 'opacity-60')}>
            <span className={clsx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', TYPE_TONE[p.type])} title={p.typeLabel} />
            <div className="min-w-0 flex-1 basis-[240px]">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {showUser ? <b className="text-[14.5px] [overflow-wrap:anywhere]">{p.userName}</b> : null}
                <span className="font-semibold [overflow-wrap:anywhere]">{p.category}</span>
                {p.auto ? <Badge tone="info">автомат</Badge> : null}
              </div>
              <div className="text-[12.5px] text-muted [overflow-wrap:anywhere]">
                {p.typeLabel}{p.orderNumber ? ` · №${p.orderNumber}` : ''}{p.pageName ? ` · ${p.pageName}` : ''}{p.customerPhone ? ` · ${p.customerPhone}` : ''}{p.customerName ? ` ${p.customerName}` : ''}
              </div>
              {p.description ? <div className="text-[12.5px] text-subtle [overflow-wrap:anywhere]">{p.description}</div> : null}
              <div className="text-[11.5px] text-subtle">{ubDateTime(p.createdAt)} · {p.createdByName}{p.deducted ? ` · хассан ${p.deductedByName}, ${ubDateTime(p.deductedAt)}` : ''}{p.status === 'CANCELLED' ? ` · цуцалсан ${p.cancelledByName}: ${p.cancelNote}` : ''}</div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <b className={clsx('text-[16px]', p.status === 'CANCELLED' ? 'line-through' : 'text-bad-ink')}>{money(p.amount)}</b>
              <StatusBadge p={p} />
              {p.status === 'ACTIVE' && !p.deducted ? (
                <div className="flex gap-1.5">
                  {canDeduct && onDeduct ? <Button size="sm" onClick={() => onDeduct(p)}>Цалингаас хасах</Button> : null}
                  {canManage && onCancel ? <Button size="sm" variant="ghost" onClick={() => onCancel(p)}>Цуцлах</Button> : null}
                </div>
              ) : null}
            </div>
          </li>
        ))}
        {!items.length ? <li className="px-4 py-12 text-center text-muted">Торгууль алга</li> : null}
      </ul>
    </section>
  );
}

function AddDialog({ staff, onClose, onDone }: { staff: Staff[]; onClose: () => void; onDone: (m: string) => void }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [q, setQ] = useState('');
  const [userId, setUserId] = useState('');
  const [type, setType] = useState('');
  const [catId, setCatId] = useState('');
  const [custom, setCustom] = useState('');
  const [saveNew, setSaveNew] = useState(true);
  const [amount, setAmount] = useState('');
  const [late, setLate] = useState('');
  const [extra, setExtra] = useState({ orderNumber: '', pageName: '', customerPhone: '', customerName: '', description: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<Config>('/api/penalties/config').then(setCfg).catch((e) => setErr(msg(e))); }, []);
  const user = staff.find((u) => u.id === userId);
  const list = useMemo(() => (cfg?.categories ?? []).filter((c) => c.active && c.type === type), [cfg, type]);
  const cat = list.find((c) => c.id === catId);
  const people = staff.filter((u) => !q || u.name.toLowerCase().includes(q.toLowerCase()) || u.phone.includes(q)).slice(0, 30);
  const pickUser = (u: Staff) => { setUserId(u.id); setType(u.defaultType ?? 'OPP_ERROR'); setCatId(''); };
  const pickCat = (c: Cat | null) => { setCatId(c?.id ?? 'CUSTOM'); if (c) setAmount(String(c.defaultAmount)); };
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      let categoryId: string | undefined = catId && catId !== 'CUSTOM' ? catId : undefined;
      if (catId === 'CUSTOM' && saveNew && custom.trim()) {
        const c = await api<Cat>('/api/penalties/config', { method: 'POST', json: { action: 'category', type, name: custom, defaultAmount: Number(amount) || 5000 } });
        categoryId = c.id;
      }
      await api('/api/penalties', { method: 'POST', json: { userId, type, categoryId, customName: categoryId ? undefined : custom, amount: Number(amount), lateMinutes: late || undefined, ...extra } });
      onDone(`${user?.name}: ${money(Number(amount))} торгууль бүртгэгдлээ`);
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="xl" title="Торгууль нэмэх" subtitle={user ? `${user.name} · ${cfg?.types.find((t) => t.type === type)?.label ?? ''}` : 'Ажилтнаа сонгоно уу'}
      footer={<><Button onClick={onClose}>Болих</Button><Button variant="primary" loading={busy} disabled={!userId || !type || !(cat || custom.trim()) || !Number(amount)} onClick={() => void submit()}>Бүртгэх</Button></>}>
      <div className="flex flex-col gap-4">
        <div>
          <div className="mb-1 text-[13px] font-bold">1. Ажилтан</div>
          {user ? (
            <div className="flex items-center justify-between rounded-[12px] bg-surface2 px-3 py-2"><b className="[overflow-wrap:anywhere]">{user.name}</b><button onClick={() => setUserId('')} className="text-[12.5px] font-semibold text-accent-ink">Солих</button></div>
          ) : (
            <>
              <input data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Нэр эсвэл утас" className="h-11 w-full rounded-xl border border-line bg-surface px-3" aria-label="Ажилтан хайх" />
              <div className="mt-1.5 flex max-h-[200px] flex-wrap gap-1.5 overflow-y-auto">{people.map((u) => <button key={u.id} onClick={() => pickUser(u)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] font-semibold hover:bg-surface2">{u.name}</button>)}</div>
            </>
          )}
        </div>
        {user ? (
          <>
            <div>
              <div className="mb-1 text-[13px] font-bold">2. Төрөл</div>
              <div className="flex flex-wrap gap-1.5">{cfg?.types.map((t) => <button key={t.type} onClick={() => { setType(t.type); setCatId(''); }} className={clsx('flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold', type === t.type ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}><span className={clsx('h-2 w-2 rounded-full', TYPE_TONE[t.type])} />{t.label}</button>)}</div>
            </div>
            <div>
              <div className="mb-1 text-[13px] font-bold">3. Алдааны нэр</div>
              <div className="flex flex-wrap gap-1.5">
                {list.map((c) => <button key={c.id} onClick={() => pickCat(c)} className={clsx('rounded-full border px-3 py-1.5 text-[13px] font-semibold', catId === c.id ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line bg-surface')}>{c.name}<span className="ml-1 text-[11.5px] opacity-70">{money(c.defaultAmount)}</span></button>)}
                <button onClick={() => pickCat(null)} className={clsx('rounded-full border border-dashed px-3 py-1.5 text-[13px] font-semibold', catId === 'CUSTOM' ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line')}>+ Шинэ алдааны нэр</button>
              </div>
              {catId === 'CUSTOM' ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  <input data-autofocus value={custom} onChange={(e) => setCustom(e.target.value)} maxLength={80} placeholder="Алдааны нэр бичнэ үү" className="h-11 rounded-xl border border-line bg-surface px-3" aria-label="Шинэ алдааны нэр" />
                  <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" className="h-4 w-4" checked={saveNew} onChange={(e) => setSaveNew(e.target.checked)} />Жагсаалтад хадгалах (дараа дахин сонгоно)</label>
                </div>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-[13px] font-bold">4. Дүн (₮)<input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} className="h-11 rounded-xl border border-line bg-surface px-3 text-[16px] font-bold" /></label>
              {cat?.lateMinutes ? <label className="flex flex-col gap-1 text-[13px] font-semibold text-muted">Хоцорсон минут<input inputMode="numeric" value={late} onChange={(e) => setLate(e.target.value.replace(/\D/g, ''))} className="h-11 rounded-xl border border-line bg-surface px-3" /></label> : null}
            </div>
            <details className="text-[13px]"><summary className="cursor-pointer font-semibold text-muted">Нэмэлт мэдээлэл (захиалга, пэйж, үйлчлүүлэгч, тайлбар)</summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {([['orderNumber', 'Захиалгын дугаар'], ['pageName', 'Пэйж'], ['customerPhone', 'Үйлчлүүлэгчийн утас'], ['customerName', 'Үйлчлүүлэгчийн нэр']] as const).map(([k, l]) => (
                  <input key={k} value={extra[k]} onChange={(e) => setExtra({ ...extra, [k]: e.target.value })} placeholder={l} aria-label={l} className="h-10 rounded-[10px] border border-line bg-surface px-3" />
                ))}
                <textarea value={extra.description} onChange={(e) => setExtra({ ...extra, description: e.target.value })} placeholder="Тайлбар" rows={2} maxLength={500} className="rounded-[10px] border border-line bg-surface px-3 py-2 sm:col-span-2" aria-label="Тайлбар" />
              </div>
            </details>
          </>
        ) : null}
        {err ? <Notice>{err}</Notice> : null}
      </div>
    </Modal>
  );
}

function CancelDialog({ p, onClose, onDone }: { p: PenaltyRow; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); try { await api(`/api/penalties/${p.id}/cancel`, { method: 'POST', json: { note } }); onDone(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); } };
  return (
    <Modal open onClose={onClose} title="Торгууль цуцлах" subtitle={`${p.userName} · ${p.category} · ${money(p.amount)}`} footer={<><Button onClick={onClose}>Болих</Button><Button variant="danger" loading={busy} disabled={note.trim().length < 3} onClick={() => void go()}>Цуцлах</Button></>}>
      <label htmlFor="pc" className="text-[13px] font-semibold text-muted">Шалтгаан (түүхэнд үлдэнэ)</label>
      <textarea id="pc" data-autofocus rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2" placeholder="Жишээ: буруу хүнд тавьсан" />
      {err ? <div className="mt-2"><Notice>{err}</Notice></div> : null}
    </Modal>
  );
}

/** Алдааны нэрс — нэмэх, засах, идэвхгүй болгох (хэрэглэгч өөрөө үүсгэнэ) */
function CategoriesDialog({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [type, setType] = useState('OPP_ERROR');
  const [edit, setEdit] = useState<{ id?: string; name: string; defaultAmount: string; lateMinutes: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api<Config>('/api/penalties/config').then(setCfg).catch((e) => setErr(msg(e))), []);
  useEffect(() => { void load(); }, [load]);
  const save = async (c: { id?: string; name: string; defaultAmount: number | string; active?: boolean; lateMinutes?: boolean }) => {
    setErr(null);
    try { await api('/api/penalties/config', { method: 'POST', json: { action: 'category', type, ...c, defaultAmount: Number(c.defaultAmount) } }); setEdit(null); await load(); } catch (e) { setErr(msg(e)); }
  };
  const list = (cfg?.categories ?? []).filter((c) => c.type === type);
  return (
    <Modal open onClose={onClose} size="xl" title="Алдааны нэрс" subtitle="«Торгууль нэмэх»-д сонгогдох алдааны нэр ба анхдагч дүн — шинээр үүсгэж, засаж, нууж болно" footer={<Button onClick={onClose}>Хаах</Button>}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">{cfg?.types.map((t) => <button key={t.type} onClick={() => { setType(t.type); setEdit(null); }} className={clsx('flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold', type === t.type ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}><span className={clsx('h-2 w-2 rounded-full', TYPE_TONE[t.type])} />{t.label}</button>)}</div>
        <ul className="divide-y divide-line rounded-[14px] border border-line">
          {list.map((c) => (
            <li key={c.id} className={clsx('flex flex-wrap items-center justify-between gap-2 px-3 py-2.5', !c.active && 'opacity-55')}>
              <span className="min-w-0 [overflow-wrap:anywhere]"><b>{c.name}</b> <span className="text-[12.5px] text-muted">· {money(c.defaultAmount)}{c.lateMinutes ? ' · минуттай' : ''}{!c.active ? ' · нуусан' : ''}</span></span>
              {cfg?.canManage ? <span className="flex gap-1.5"><Button size="sm" variant="ghost" onClick={() => setEdit({ id: c.id, name: c.name, defaultAmount: String(c.defaultAmount), lateMinutes: !!c.lateMinutes })}>Засах</Button><Button size="sm" variant="ghost" onClick={() => void save({ id: c.id, name: c.name, defaultAmount: c.defaultAmount, active: !c.active })}>{c.active ? 'Нуух' : 'Сэргээх'}</Button></span> : null}
            </li>
          ))}
          {!list.length ? <li className="px-3 py-4 text-center text-[13px] text-muted">Алдааны нэр алга — «Бусад»-аар гараар бичнэ</li> : null}
        </ul>
        {cfg?.canManage ? (edit ? (
          <div className="grid gap-2 rounded-[14px] border border-line p-3 sm:grid-cols-[1fr_140px_auto_auto]">
            <input data-autofocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={80} placeholder="Алдааны нэр" className="h-10 rounded-[10px] border border-line bg-surface px-3" aria-label="Алдааны нэр" />
            <input inputMode="numeric" value={edit.defaultAmount} onChange={(e) => setEdit({ ...edit, defaultAmount: e.target.value.replace(/\D/g, '') })} placeholder="Дүн ₮" className="h-10 rounded-[10px] border border-line bg-surface px-3" aria-label="Анхдагч дүн" />
            <label className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" className="h-4 w-4" checked={edit.lateMinutes} onChange={(e) => setEdit({ ...edit, lateMinutes: e.target.checked })} />Минут асуух</label>
            <span className="flex gap-1.5"><Button size="sm" onClick={() => setEdit(null)}>Болих</Button><Button size="sm" variant="primary" onClick={() => void save({ id: edit.id, name: edit.name, defaultAmount: edit.defaultAmount, lateMinutes: edit.lateMinutes })}>Хадгалах</Button></span>
          </div>
        ) : <Button variant="dark" onClick={() => setEdit({ name: '', defaultAmount: '5000', lateMinutes: false })}>+ Шинэ алдааны нэр</Button>) : null}
        {err ? <Notice>{err}</Notice> : null}
      </div>
    </Modal>
  );
}

function StaffInfo({ staff }: { staff: Staff[] }) {
  const [id, setId] = useState('');
  const [q, setQ] = useState('');
  const [d, setD] = useState<{ user: { name: string; phone: string }; summary: Summary; recent: PenaltyRow[]; loans: { id: number; issuedAt: string; pieces: number; amount: number; note: string | null }[]; loanTotal: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (id) api<NonNullable<typeof d>>(`/api/penalties?employee=${id}`).then(setD).catch((e) => setErr(msg(e))); }, [id]);
  const people = staff.filter((u) => !q || u.name.toLowerCase().includes(q.toLowerCase()) || u.phone.includes(q));
  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <div className="rounded-[20px] border border-line bg-surface p-3 shadow-card">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ажилтан хайх" className="h-10 w-full rounded-[10px] border border-line bg-surface px-3" aria-label="Ажилтан хайх" />
        <ul className="mt-2 max-h-[480px] overflow-y-auto">{people.map((u) => <li key={u.id}><button onClick={() => setId(u.id)} className={clsx('w-full rounded-[10px] px-3 py-2 text-left text-[13.5px] [overflow-wrap:anywhere]', id === u.id ? 'bg-ink font-bold text-on-ink' : 'hover:bg-surface2')}>{u.name}</button></li>)}</ul>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        {err ? <Notice>{err}</Notice> : null}
        {!id ? <p className="rounded-[20px] border border-dashed border-line p-10 text-center text-muted">Зүүн талаас ажилтан сонгоно уу</p> : d ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([['Нийт торгууль', money(d.summary.total), null], ['Хасагдаагүй', money(d.summary.pending), 'bad'], ['Цалингаас хассан', money(d.summary.deducted), 'ok'], ['Буцаагаагүй зээл', money(d.loanTotal), d.loanTotal ? 'bad' : null]] as const).map(([l, v, t]) => (
                <div key={l} className="min-w-0 rounded-[14px] bg-surface2 px-3 py-2.5"><div className="text-[12px] font-semibold text-muted">{l}</div><div className={clsx('truncate text-[18px] font-extrabold', t === 'bad' && 'text-bad-ink', t === 'ok' && 'text-ok-ink')}>{v}</div></div>
              ))}
            </div>
            {d.loans.length ? (
              <section className="rounded-[16px] border border-line bg-surface p-3">
                <div className="mb-1 text-[13px] font-extrabold">Буцаагаагүй барааны зээл</div>
                {d.loans.map((l) => <div key={l.id} className="flex justify-between gap-2 py-1 text-[13px]"><span className="min-w-0 [overflow-wrap:anywhere]">Зээл #{l.id} · {l.pieces}ш · {ubDateTime(l.issuedAt)}{l.note ? ` · ${l.note}` : ''}</span><b className="shrink-0">{money(l.amount)}</b></div>)}
              </section>
            ) : null}
            <PenaltyList items={d.recent} />
          </>
        ) : null}
      </div>
    </div>
  );
}
