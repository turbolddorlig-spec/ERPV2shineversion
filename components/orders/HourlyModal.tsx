'use client';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Icon } from '@/components/icons';
import { api, ApiError } from '@/components/ui/api';

interface Row { rank: number; operatorId: string; name: string; cum: number[]; total: number; me: boolean }
interface Hourly { date: string; cuts: number[]; rows: Row[]; total: number }
interface Team { name: string; color: string; members: string[] }

/** Хуучин ERP-ийн 6 өнгө */
const COLORS: Record<string, { label: string; head: string; body: string; border: string; text: string; dot: string }> = {
  blue: { label: 'Цэнхэр', head: 'bg-blue-500/15', body: 'bg-blue-500/5', border: 'border-blue-500/30', text: 'text-blue-700 dark:text-blue-300', dot: 'bg-blue-500' },
  green: { label: 'Ногоон', head: 'bg-green-500/15', body: 'bg-green-500/5', border: 'border-green-500/30', text: 'text-green-700 dark:text-green-300', dot: 'bg-green-500' },
  amber: { label: 'Улбар шар', head: 'bg-amber-500/15', body: 'bg-amber-500/5', border: 'border-amber-500/30', text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
  rose: { label: 'Ягаан', head: 'bg-rose-500/15', body: 'bg-rose-500/5', border: 'border-rose-500/30', text: 'text-rose-700 dark:text-rose-300', dot: 'bg-rose-500' },
  teal: { label: 'Нил', head: 'bg-teal-500/15', body: 'bg-teal-500/5', border: 'border-teal-500/30', text: 'text-teal-700 dark:text-teal-300', dot: 'bg-teal-500' },
  slate: { label: 'Саарал', head: 'bg-slate-500/15', body: 'bg-slate-500/5', border: 'border-slate-500/30', text: 'text-slate-700 dark:text-slate-300', dot: 'bg-slate-500' },
};
const col = (c: string) => COLORS[c] ?? COLORS.slate!;
const ubToday = (add = 0) => new Date(Date.now() + 8 * 3600_000 + add * 86_400_000).toISOString().slice(0, 10);
const dayLabel = (d: string) => (d === ubToday() ? 'Өнөөдөр' : d === ubToday(-1) ? 'Өчигдөр' : d);
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');

/**
 * Цагийн мэдээ — хуучин ERP шиг: «Мэдээ» / «Баг тохиргоо» таб, Өнөөдөр · Өчигдөр · уржигдар,
 * багаар бүлэглэсэн хүснэгт (11:00 · 13:00 · 15:00 · 18:00 · 21:00 · Нийт).
 */
export function HourlyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'report' | 'teams'>('report');
  const [date, setDate] = useState(ubToday());
  const [h, setH] = useState<Hourly | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [ops, setOps] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadReport = useCallback((d: string) => { setH(null); return api<Hourly>(`/api/orders/hourly?date=${d}`).then(setH).catch((e) => setError(msg(e))); }, []);
  useEffect(() => {
    if (!open) return;
    setError(null);
    loadReport(date);
    api<{ teams: Team[]; canEdit: boolean }>('/api/orders/teams').then((r) => { setTeams(r.teams); setCanEdit(r.canEdit); }).catch(() => undefined);
    api<{ items: { id: string; name: string }[] }>('/api/calls/operators').then((r) => setOps(r.items)).catch(() => undefined);
    const t = setInterval(() => { if (date === ubToday()) api<Hourly>(`/api/orders/hourly?date=${date}`).then(setH).catch(() => undefined); }, 60_000);
    return () => clearInterval(t);
  }, [open, date, loadReport]);

  async function save(next: Team[]) {
    setSaving(true); setError(null);
    try { const r = await api<{ teams: Team[] }>('/api/orders/teams', { method: 'POST', json: { teams: next } }); setTeams(r.teams); }
    catch (e) { setError(msg(e)); } finally { setSaving(false); }
  }

  const nameOf = (id: string) => ops.find((o) => o.id === id)?.name ?? h?.rows.find((r) => r.operatorId === id)?.name ?? '—';
  const assigned = new Set(teams.flatMap((t) => t.members));
  const unassigned = (h?.rows ?? []).filter((r) => !assigned.has(r.operatorId));

  return (
    <Modal open={open} onClose={onClose} size="xl" title="🕐 Цагийн мэдээ">
      <div className="mx-auto flex max-w-[860px] flex-col gap-3 text-[13px]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex rounded-lg bg-surface2 p-1">
            {([['report', 'Мэдээ'], ['teams', '⚙ Баг тохиргоо']] as const).map(([v, l]) => (
              <button key={v} type="button" aria-pressed={tab === v} onClick={() => setTab(v)} className={clsx('h-8 rounded-md px-3 text-[13px] font-semibold', tab === v ? 'bg-surface shadow-card' : 'text-muted')}>{l}</button>
            ))}
          </div>
          {tab === 'report' ? (
            <div className="flex gap-1.5">
              {[0, -1, -2].map((o) => ubToday(o)).map((d) => (
                <button key={d} type="button" aria-pressed={date === d} onClick={() => setDate(d)} className={clsx('h-8 rounded-lg border px-3 text-[12px] font-semibold', date === d ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface')}>{dayLabel(d)}</button>
              ))}
            </div>
          ) : null}
        </div>
        {error ? <Notice>{error}</Notice> : null}

        {tab === 'report' ? (
          !h ? <p className="py-10 text-center text-muted">Ачаалж байна…</p> : h.rows.length ? (
            <div className="flex flex-col gap-3">
              {teams.length ? (
                <>
                  {teams.map((t) => {
                    const rows = h.rows.filter((r) => t.members.includes(r.operatorId));
                    if (!rows.length) return null;
                    const c = col(t.color);
                    return (
                      <div key={t.name} className={clsx('overflow-hidden rounded-lg border', c.border)}>
                        <div className={clsx('flex items-center justify-between px-3 py-2', c.head)}>
                          <span className={clsx('text-[13px] font-semibold', c.text)}>{t.name}</span>
                          <span className="rounded-md bg-surface px-2 py-0.5 text-[12px] font-bold">{rows.reduce((a, r) => a + r.total, 0)}</span>
                        </div>
                        <div className={c.body}><ReportTable rows={rows} cuts={h.cuts} /></div>
                      </div>
                    );
                  })}
                  {unassigned.length ? (
                    <div className="overflow-hidden rounded-lg border border-line">
                      <div className="bg-surface2 px-3 py-2 text-[13px] font-semibold text-muted">Багт хуваарилагдаагүй</div>
                      <ReportTable rows={unassigned} cuts={h.cuts} />
                    </div>
                  ) : null}
                </>
              ) : <div className="overflow-hidden rounded-lg border border-line"><ReportTable rows={h.rows} cuts={h.cuts} /></div>}
              <p className="text-right text-[12px] text-subtle">Нийт: {h.total} захиалга, {h.rows.length} оператор</p>
            </div>
          ) : <p className="py-10 text-center text-subtle">Энэ өдрийн мэдээлэл олдсонгүй</p>
        ) : (
          <TeamsConfig teams={teams} ops={ops} canEdit={canEdit} saving={saving} nameOf={nameOf} onSave={save} />
        )}
      </div>
    </Modal>
  );
}

function ReportTable({ rows, cuts }: { rows: Row[]; cuts: number[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-[13px]">
        <thead>
          <tr className="border-b border-line/70 text-[12px] text-muted">
            <th className="w-8 px-3 py-2 text-left font-medium">#</th>
            <th className="px-3 py-2 text-left font-medium">Оператор</th>
            {cuts.map((c) => <th key={c} className="w-14 px-2 py-2 text-center font-medium">{c}:00</th>)}
            <th className="w-16 px-3 py-2 text-center font-bold text-ink">Нийт</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.operatorId} className={clsx('border-b border-line/50 last:border-0', r.me && 'bg-accent-soft/60')}>
              <td className="px-3 py-1.5 text-[12px] text-subtle">{i + 1}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-[12.5px] font-medium">{r.name}{r.me ? <span className="ml-1 text-[11px] text-accent-ink">(та)</span> : null}</td>
              {r.cum.map((n, j) => <td key={j} className="px-2 py-1.5 text-center"><span className={clsx('text-[12.5px] font-medium', n > 0 ? 'text-ink' : 'text-line')}>{n || '-'}</span></td>)}
              <td className="px-3 py-1.5 text-center"><span className="text-[12.5px] font-bold text-info">{r.total}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TeamsConfig({ teams, ops, canEdit, saving, nameOf, onSave }: {
  teams: Team[]; ops: { id: string; name: string }[]; canEdit: boolean; saving: boolean; nameOf: (id: string) => string; onSave: (t: Team[]) => void;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState('blue');
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const assigned = new Set(teams.flatMap((t) => t.members));
  const available = ops.filter((o) => !assigned.has(o.id));
  const add = () => { const n = name.trim(); if (!n) return; onSave([...teams, { name: n, color, members: [] }]); setName(''); };
  return (
    <div className="flex flex-col gap-3">
      {!canEdit ? <p className="rounded-lg bg-surface2 px-3 py-2 text-[12.5px] text-muted">Багийг ахлах оператор, админ тохируулна.</p> : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[12px] text-muted">Шинэ баг нэмэх
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} placeholder="Багийн нэр..." className="h-8 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-accent" />
          </label>
          <select aria-label="Өнгө" value={color} onChange={(e) => setColor(e.target.value)} className="h-8 w-32 rounded-lg border border-line bg-surface px-2 text-[12.5px]">
            {Object.entries(COLORS).map(([v, c]) => <option key={v} value={v}>{c.label}</option>)}
          </select>
          <button type="button" aria-label="Баг нэмэх" disabled={!name.trim() || saving} onClick={add} className="grid h-8 w-9 place-items-center rounded-lg bg-ink text-on-ink disabled:opacity-50"><Icon name="plus" size={15} /></button>
        </div>
      )}
      {teams.map((t) => {
        const c = col(t.color);
        return (
          <div key={t.name} className={clsx('overflow-hidden rounded-lg border', c.border)}>
            <div className={clsx('flex items-center justify-between px-3 py-2', c.head)}>
              <span className={clsx('text-[13px] font-semibold', c.text)}>{t.name}</span>
              <span className="flex items-center gap-2">
                <span className="rounded-md bg-surface px-2 py-0.5 text-[11.5px]">{t.members.length} гишүүн</span>
                {canEdit ? <button type="button" aria-label={`${t.name} устгах`} onClick={() => { if (confirm(`«${t.name}» багийг устгах уу?`)) onSave(teams.filter((x) => x.name !== t.name)); }} className="grid h-6 w-6 place-items-center rounded text-muted hover:text-bad-ink"><Icon name="close" size={13} /></button> : null}
              </span>
            </div>
            <div className={clsx('p-3', c.body)}>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {t.members.map((m) => (
                  <span key={m} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface py-0.5 pl-2 pr-1 text-[12px]">
                    {nameOf(m)}
                    {canEdit ? <button type="button" aria-label="Хасах" onClick={() => onSave(teams.map((x) => (x.name === t.name ? { ...x, members: x.members.filter((y) => y !== m) } : x)))} className="hover:text-bad-ink"><Icon name="close" size={11} /></button> : null}
                  </span>
                ))}
                {!t.members.length ? <span className="text-[12px] text-subtle">Гишүүн нэмэх...</span> : null}
              </div>
              {canEdit ? (addingTo === t.name ? (
                <select autoFocus aria-label="Оператор сонгох" defaultValue="" onBlur={() => setAddingTo(null)}
                  onChange={(e) => { if (e.target.value) onSave(teams.map((x) => (x.name === t.name ? { ...x, members: [...x.members, e.target.value] } : x))); setAddingTo(null); }}
                  className="h-7 w-52 rounded-md border border-line bg-surface px-2 text-[12px]">
                  <option value="">Оператор сонгох...</option>
                  {available.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              ) : <button type="button" onClick={() => setAddingTo(t.name)} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-semibold text-muted hover:bg-surface"><Icon name="plus" size={12} />Гишүүн нэмэх</button>) : null}
            </div>
          </div>
        );
      })}
      {!teams.length ? <p className="py-6 text-center text-[12.5px] text-subtle">Баг үүсээгүй байна{canEdit ? ' — дээрээс нэмнэ үү' : ''}</p> : null}
    </div>
  );
}
