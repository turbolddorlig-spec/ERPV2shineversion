'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';

type RoleOpt = { value: string; label: string };
interface Row {
  id: string; phone: string; name: string; roles: string[]; isActive: boolean; mustChangePassword: boolean;
  lockedUntil: string | null; lastLoginAt: string | null; createdAt: string; canManage: boolean;
}
interface ListResp { items: Row[]; total: number; page: number; pageSize: number }
interface HistoryItem { id: string; at: string; actorName: string; action: string; details: unknown }

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Супер админ', ADMIN: 'Админ', OPERATOR_LEAD: 'Ахлах оператор', OPERATOR: 'Оператор',
  DRIVER_LEAD: 'Ахлах жолооч', DRIVER: 'Жолооч', ACCOUNTING: 'Нягтлан', WAREHOUSE: 'Агуулах',
  MARKETING_LEAD: 'Ахлах маркетинг', MARKETING: 'Маркетинг', PENALTY_OFFICER: 'Торгуулийн ажилтан', SUPPLIER: 'Нийлүүлэгч',
};
const ACTION_LABEL: Record<string, string> = {
  'auth.login': 'Нэвтэрсэн', 'auth.login_failed': 'Буруу нууц үгээр оролдсон', 'auth.locked': 'Түгжигдсэн (5 буруу оролдлого)',
  'auth.logout': 'Гарсан', 'auth.logout_all': 'Бүх төхөөрөмжөөс гарсан', 'auth.password_changed': 'Нууц үгээ сольсон',
  'user.created': 'Хэрэглэгч үүсгэсэн', 'user.updated': 'Мэдээлэл засварласан', 'user.deactivated': 'Эрхийг хаасан',
  'user.activated': 'Эрхийг нээсэн', 'user.password_reset': 'Нууц үг сэргээсэн', 'user.unlocked': 'Түгжээ тайлсан',
};
const STATUS = [
  { v: 'active', l: 'Идэвхтэй' }, { v: 'locked', l: 'Түгжигдсэн' }, { v: 'inactive', l: 'Хаасан' }, { v: 'all', l: 'Бүгд' },
];

const fmtPhone = (p: string) => (p.length === 8 ? `${p.slice(0, 4)}-${p.slice(4)}` : p);
/** Улаанбаатарын цагаар: 2026.11.10 21:11 */
const fmtDate = (s: string | null) => {
  if (!s) return '—';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ulaanbaatar', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(s)).map((x) => [x.type, x.value]));
  return `${p.year}.${p.month}.${p.day} ${p.hour}:${p.minute}`;
};
const isLocked = (r: Row) => !!r.lockedUntil && new Date(r.lockedUntil).getTime() > Date.now();

function StatusBadge({ r }: { r: Row }) {
  if (!r.isActive) return <Badge tone="neutral">Хаасан</Badge>;
  if (isLocked(r)) return <Badge tone="bad"><Icon name="lock" size={12} strokeWidth={2.4} />Түгжигдсэн</Badge>;
  if (r.mustChangePassword) return <Badge tone="warn">Түр нууц үгтэй</Badge>;
  return <Badge tone="ok">Идэвхтэй</Badge>;
}

export function UsersClient({ assignable, canUnlock, selfId }: { assignable: RoleOpt[]; canUnlock: boolean; selfId: string }) {
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [form, setForm] = useState<{ mode: 'create' | 'edit'; row?: Row } | null>(null);
  const [actionsFor, setActionsFor] = useState<Row | null>(null);
  const [confirm, setConfirm] = useState<{ row: Row; kind: 'deactivate' | 'reset' } | null>(null);
  const [tempPw, setTempPw] = useState<{ name: string; phone: string; password: string } | null>(null);
  const [history, setHistory] = useState<{ row: Row; items: HistoryItem[] | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true); setError(null);
    const sp = new URLSearchParams({ status, page: String(page) });
    if (q.trim()) sp.set('q', q.trim());
    if (role) sp.set('role', role);
    try {
      const r = await api<ListResp>(`/api/users?${sp}`);
      if (id === reqId.current) setData(r);
    } catch (e) {
      if (id === reqId.current) setError(e instanceof ApiError ? e.message : 'Ачаалж чадсангүй');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [q, role, status, page]);

  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 4000); return () => clearTimeout(t); }, [flash]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  async function runAction(row: Row, action: 'activate' | 'deactivate' | 'unlock' | 'reset-password') {
    setBusy(true);
    try {
      const r = await api<{ temporaryPassword?: string; user?: { warning?: string | null } }>(`/api/users/${row.id}/${action}`, { method: 'POST', json: {} });
      if (action === 'reset-password' && r.temporaryPassword) setTempPw({ name: row.name, phone: row.phone, password: r.temporaryPassword });
      setFlash(r.user?.warning ? `Эрхийг хаалаа. ${r.user.warning}` : { activate: 'Эрхийг нээлээ', deactivate: 'Эрхийг хаалаа. Бүх төхөөрөмжөөс гаргасан.', unlock: 'Түгжээг тайллаа', 'reset-password': 'Түр нууц үг үүслээ' }[action]);
      setConfirm(null); setActionsFor(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Алдаа гарлаа');
      setConfirm(null); setActionsFor(null);
    } finally {
      setBusy(false);
    }
  }

  async function openHistory(row: Row) {
    setActionsFor(null);
    setHistory({ row, items: null });
    try {
      const r = await api<{ items: HistoryItem[] }>(`/api/users/${row.id}/history`);
      setHistory({ row, items: r.items });
    } catch (e) {
      setHistory(null);
      setError(e instanceof ApiError ? e.message : 'Түүх ачаалж чадсангүй');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-11 min-w-0 flex-[1_1_240px] items-center gap-2 rounded-xl border border-line bg-surface px-3 text-subtle md:h-10">
          <Icon name="search" size={16} />
          <span className="sr-only">Хайх</span>
          <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Нэр эсвэл утасны дугаар"
            className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-subtle" />
        </label>
        <label className="sr-only" htmlFor="role-filter">Role</label>
        <select id="role-filter" value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}
          className="h-11 flex-[1_1_160px] rounded-xl border border-line bg-surface px-3 text-ink md:h-10 md:flex-none">
          <option value="">Бүх role</option>
          {assignable.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        <Button variant="primary" onClick={() => setForm({ mode: 'create' })} className="flex-[1_1_100%] sm:flex-none">
          <Icon name="plus" size={16} strokeWidth={2.4} /> Хэрэглэгч нэмэх
        </Button>
      </div>

      <div role="group" aria-label="Төлөв" className="flex gap-1.5 overflow-x-auto">
        {STATUS.map((s) => (
          <button key={s.v} type="button" aria-pressed={status === s.v} onClick={() => { setStatus(s.v); setPage(1); }}
            className={clsx('h-10 shrink-0 rounded-full border px-4 text-[13.5px] font-semibold',
              status === s.v ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-ink')}>
            {s.l}
          </button>
        ))}
      </div>

      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}

      {/* Компьютер: хүснэгт */}
      <div className="hidden overflow-hidden rounded-[16px] border border-line bg-surface shadow-card md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-[13.5px]">
            <thead>
              <tr className="bg-surface2 text-left text-[12px] text-muted">
                <th scope="col" className="border-b border-line px-4 py-2.5 font-bold">Нэр</th>
                <th scope="col" className="border-b border-line px-3 py-2.5 font-bold">Утас</th>
                <th scope="col" className="border-b border-line px-3 py-2.5 font-bold">Role</th>
                <th scope="col" className="border-b border-line px-3 py-2.5 font-bold">Төлөв</th>
                <th scope="col" className="border-b border-line px-3 py-2.5 font-bold">Сүүлд нэвтэрсэн</th>
                <th scope="col" className="border-b border-line px-4 py-2.5"><span className="sr-only">Үйлдэл</span></th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id} className={clsx(!r.isActive && 'opacity-60')}>
                  <td className="border-b border-line px-4 py-3 font-semibold">{r.name}{r.id === selfId ? <span className="ml-2 text-[12px] font-medium text-subtle">(та)</span> : null}</td>
                  <td className="border-b border-line px-3 py-3">{fmtPhone(r.phone)}</td>
                  <td className="border-b border-line px-3 py-3"><div className="flex flex-wrap gap-1">{r.roles.map((x) => <Badge key={x} tone="neutral">{ROLE_LABEL[x] ?? x}</Badge>)}</div></td>
                  <td className="border-b border-line px-3 py-3"><StatusBadge r={r} /></td>
                  <td className="border-b border-line px-3 py-3 text-muted">{fmtDate(r.lastLoginAt)}</td>
                  <td className="border-b border-line px-4 py-2 text-right">
                    {r.canManage ? <Button size="sm" onClick={() => setActionsFor(r)}>Үйлдэл</Button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Гар утас: карт */}
      <ul className="flex flex-col gap-2.5 md:hidden">
        {data?.items.map((r) => (
          <li key={r.id} className={clsx('rounded-[16px] border border-line bg-surface p-3.5 shadow-card', !r.isActive && 'opacity-70')}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[15.5px] font-bold">{r.name}{r.id === selfId ? <span className="ml-1 text-[12px] font-medium text-subtle">(та)</span> : null}</p>
                <p className="text-[14px] text-muted">{fmtPhone(r.phone)}</p>
              </div>
              <StatusBadge r={r} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1">{r.roles.map((x) => <Badge key={x} tone="neutral">{ROLE_LABEL[x] ?? x}</Badge>)}</div>
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-dashed border-line pt-2.5">
              <span className="text-[12.5px] text-subtle">Сүүлд: {fmtDate(r.lastLoginAt)}</span>
              {r.canManage ? <Button size="sm" onClick={() => setActionsFor(r)}>Үйлдэл</Button> : null}
            </div>
          </li>
        ))}
      </ul>

      {!loading && data && data.items.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-line bg-surface p-8 text-center text-muted">Хэрэглэгч олдсонгүй</div>
      ) : null}
      {loading && !data ? <p className="py-6 text-center text-muted">Ачаалж байна…</p> : null}

      {data && data.total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[13.5px] text-muted">
          <span>{(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} / {data.total}</span>
          <div className="flex gap-2">
            <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Өмнөх хуудас"><Icon name="left" size={15} /> Өмнөх</Button>
            <Button size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Дараах хуудас">Дараах <Icon name="right" size={15} /></Button>
          </div>
        </div>
      ) : null}

      {/* Үйлдлийн цэс */}
      <Modal open={!!actionsFor} onClose={() => setActionsFor(null)} title={actionsFor?.name ?? ''}>
        {actionsFor ? (
          <div className="flex flex-col gap-2">
            <Button className="w-full justify-start" onClick={() => { setForm({ mode: 'edit', row: actionsFor }); setActionsFor(null); }}>Засах (нэр, утас, role)</Button>
            <Button className="w-full justify-start" onClick={() => setConfirm({ row: actionsFor, kind: 'reset' })}>Нууц үг сэргээх</Button>
            {canUnlock && isLocked(actionsFor) ? (
              <Button className="w-full justify-start" loading={busy} onClick={() => runAction(actionsFor, 'unlock')}>Түгжээ тайлах</Button>
            ) : null}
            <Button className="w-full justify-start" onClick={() => openHistory(actionsFor)}>Түүх харах</Button>
            {actionsFor.isActive
              ? <Button variant="danger" className="w-full justify-start" onClick={() => setConfirm({ row: actionsFor, kind: 'deactivate' })}>Эрхийг хаах</Button>
              : <Button className="w-full justify-start" loading={busy} onClick={() => runAction(actionsFor, 'activate')}>Эрхийг нээх</Button>}
          </div>
        ) : null}
      </Modal>

      <Modal open={!!confirm} onClose={() => setConfirm(null)}
        title={confirm?.kind === 'deactivate' ? 'Эрхийг хаах уу?' : 'Нууц үг сэргээх үү?'}
        footer={confirm ? (<>
          <Button onClick={() => setConfirm(null)}>Болих</Button>
          <Button variant={confirm.kind === 'deactivate' ? 'danger' : 'primary'} loading={busy}
            onClick={() => runAction(confirm.row, confirm.kind === 'deactivate' ? 'deactivate' : 'reset-password')}>
            {confirm.kind === 'deactivate' ? 'Хаах' : 'Сэргээх'}
          </Button>
        </>) : null}>
        {confirm ? (
          <p className="text-[14.5px] text-muted">
            {confirm.kind === 'deactivate'
              ? <><strong className="text-ink">{confirm.row.name}</strong> нэвтэрч чадахгүй болж, бүх төхөөрөмжөөс шууд гарна. Дараа нь дахин нээж болно.</>
              : <><strong className="text-ink">{confirm.row.name}</strong>-д түр нууц үг үүсгэнэ. Одоогийн нууц үг ажиллахгүй болж, бүх төхөөрөмжөөс гарна. Анх нэвтрэхдээ шинэ нууц үгээ тохируулна.</>}
          </p>
        ) : null}
      </Modal>

      <Modal open={!!tempPw} onClose={() => setTempPw(null)} title="Түр нууц үг"
        footer={<Button variant="dark" onClick={() => setTempPw(null)}>Ойлголоо</Button>}>
        {tempPw ? <TempPasswordView {...tempPw} /> : null}
      </Modal>

      <Modal open={!!history} onClose={() => setHistory(null)} title={`Түүх · ${history?.row.name ?? ''}`}>
        {history?.items === null ? <p className="text-muted">Ачаалж байна…</p> : null}
        {history?.items?.length === 0 ? <p className="text-muted">Түүх алга</p> : null}
        <ol className="flex flex-col gap-2">
          {history?.items?.map((h) => (
            <li key={h.id} className="rounded-xl bg-surface2 px-3 py-2.5">
              <p className="text-[14px] font-semibold">{ACTION_LABEL[h.action] ?? h.action}</p>
              <p className="text-[12.5px] text-muted">{fmtDate(h.at)} · {h.actorName}</p>
            </li>
          ))}
        </ol>
      </Modal>

      {form ? (
        <UserFormModal
          key={form.row?.id ?? 'new'}
          mode={form.mode}
          row={form.row}
          assignable={assignable}
          isSelf={form.row?.id === selfId}
          onClose={() => setForm(null)}
          onSaved={async (res) => {
            setForm(null);
            if (res.temporaryPassword && res.user) setTempPw({ name: res.user.name, phone: res.user.phone, password: res.temporaryPassword });
            setFlash(form.mode === 'create' ? 'Хэрэглэгч нэмэгдлээ' : 'Хадгаллаа');
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

function TempPasswordView({ name, phone, password }: { name: string; phone: string; password: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  // HTTP (домэйнгүй, IP хаягаар) үед navigator.clipboard байхгүй — хуучин аргаар хуулна; болохгүй бол ил хэлнэ
  async function copy() {
    try {
      if (window.isSecureContext && navigator.clipboard) { await navigator.clipboard.writeText(password); setCopied(true); return; }
    } catch { /* доорх аргаар */ }
    try {
      const t = document.createElement('textarea');
      t.value = password; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
      // Нээлттэй цонх (dialog) гаднах элемент идэвхгүй тул цонх дотор нь үүсгэнэ
      const host = (document.activeElement?.closest('dialog') as HTMLElement | null) ?? document.querySelector('dialog[open]') ?? document.body;
      host.appendChild(t); t.focus(); t.select(); t.setSelectionRange(0, password.length);
      const ok = document.execCommand('copy') && t.selectionEnd - t.selectionStart === password.length;
      host.removeChild(t);
      setCopied(ok);
    } catch { setCopied(false); }
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[14px] text-muted"><strong className="text-ink">{name}</strong> ({fmtPhone(phone)}) энэ түр нууц үгээр нэвтэрч, шинэ нууц үгээ тохируулна.</p>
      <div className="flex items-center gap-2 rounded-xl border-2 border-dashed border-accent bg-accent-soft p-3">
        <code className="flex-1 select-all text-center text-[24px] font-extrabold tracking-[0.12em] text-accent-ink">{password}</code>
        <Button size="sm" onClick={copy} aria-label="Хуулах"><Icon name={copied ? 'check' : 'copy'} size={15} />{copied ? 'Хуулсан' : 'Хуулах'}</Button>
      </div>
      {copied === false ? <Notice>Хуулж чадсангүй — нууц үгийг гараар бичиж өгнө үү (бүгд жижиг үсэг, тоо)</Notice> : null}
      <p className="text-[12.5px] text-subtle">Бүгд жижиг латин үсэг ба тоо — том үсэг, зай байхгүй.</p>
      <Notice tone="warn">Энэ нууц үг зөвхөн одоо харагдана. Хаасны дараа дахин харах боломжгүй.</Notice>
    </div>
  );
}

function UserFormModal({ mode, row, assignable, isSelf, onClose, onSaved }: {
  mode: 'create' | 'edit'; row?: Row; assignable: RoleOpt[]; isSelf: boolean;
  onClose: () => void; onSaved: (r: { user?: { name: string; phone: string }; temporaryPassword?: string | null }) => void;
}) {
  const [name, setName] = useState(row?.name ?? '');
  const [phone, setPhone] = useState(row?.phone ?? '');
  const [roles, setRoles] = useState<string[]>(row?.roles ?? (assignable.length === 1 ? [assignable[0]!.value] : []));
  const [ownPassword, setOwnPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const locked = useMemo(() => (row?.roles ?? []).filter((r) => !assignable.some((a) => a.value === r)), [row, assignable]);

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (saving) return;
    setError(null); setSaving(true);
    try {
      if (mode === 'create') {
        const r = await api<{ user: { name: string; phone: string }; temporaryPassword: string | null }>('/api/users', {
          method: 'POST', json: { name, phone, roles, password: ownPassword ? password : undefined },
        });
        onSaved(r);
      } else if (row) {
        const body: Record<string, unknown> = { name, phone };
        if (!isSelf) body.roles = roles;
        const r = await api<{ user: { name: string; phone: string } }>(`/api/users/${row.id}`, { method: 'PATCH', json: body });
        onSaved(r);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Хадгалж чадсангүй');
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={mode === 'create' ? 'Хэрэглэгч нэмэх' : 'Хэрэглэгч засах'}
      footer={<><Button onClick={onClose}>Болих</Button><Button variant="primary" loading={saving} onClick={() => save()}>Хадгалах</Button></>}>
      <form onSubmit={save} className="flex flex-col gap-4" noValidate>
        {error ? <Notice>{error}</Notice> : null}
        <Field id="u-name" label="Нэр" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        <Field id="u-phone" label="Утасны дугаар (нэвтрэх нэр)" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={12} autoComplete="off" />
        <fieldset className="flex flex-col gap-2" disabled={isSelf}>
          <legend className="mb-1.5 text-[13px] font-semibold text-muted">Role {assignable.length > 1 ? '(нэг хүнд хэд хэдийг сонгож болно)' : ''}</legend>
          {isSelf ? <p className="text-[12.5px] text-subtle">Өөрийн role-ийг өөрөө өөрчлөх боломжгүй.</p> : null}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {assignable.map((r) => (
              <label key={r.value} className={clsx('flex min-h-[46px] cursor-pointer items-center gap-3 rounded-xl border px-3',
                roles.includes(r.value) ? 'border-accent bg-accent-soft' : 'border-line bg-surface')}>
                <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={roles.includes(r.value)}
                  onChange={(e) => setRoles((cur) => e.target.checked ? [...cur, r.value] : cur.filter((x) => x !== r.value))} />
                <span className="text-[14px] font-semibold">{r.label}</span>
              </label>
            ))}
          </div>
          {locked.length ? <p className="text-[12.5px] text-subtle">Таны өөрчлөх боломжгүй role: {locked.map((r) => ROLE_LABEL[r]).join(', ')}</p> : null}
        </fieldset>
        {mode === 'create' ? (
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-3 text-[14px] font-semibold">
              <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={ownPassword} onChange={(e) => setOwnPassword(e.target.checked)} />
              Нууц үгийг өөрөө тохируулах
            </label>
            {ownPassword
              ? <Field id="u-pw" label="Нууц үг" type="password" autoComplete="new-password" hint="Дор хаяж 6 тэмдэгт" value={password} onChange={(e) => setPassword(e.target.value)} />
              : <p className="text-[12.5px] text-subtle">Сонгоогүй бол систем түр нууц үг үүсгэж, ажилтан анх нэвтрэхдээ солино.</p>}
          </div>
        ) : null}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
