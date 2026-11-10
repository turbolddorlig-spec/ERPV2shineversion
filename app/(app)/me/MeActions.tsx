'use client';
import clsx from 'clsx';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/icons';

const OPTIONS = [
  { v: 'SYSTEM', l: 'Төхөөрөмжөөр' },
  { v: 'LIGHT', l: 'Light' },
  { v: 'DARK', l: 'Dark' },
] as const;

export function MeActions({ theme }: { theme: string }) {
  const [current, setCurrent] = useState(theme);
  const [busy, setBusy] = useState<string | null>(null);

  async function choose(v: string) {
    setCurrent(v);
    if (v === 'SYSTEM') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = v.toLowerCase();
    await fetch('/api/me/theme', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: v }) }).catch(() => undefined);
  }

  async function out(all: boolean) {
    setBusy(all ? 'all' : 'one');
    await fetch(all ? '/api/auth/logout-all' : '/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.href = '/login';
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-2 text-[13px] font-semibold text-muted">Өнгөний горим</p>
        <div role="radiogroup" aria-label="Өнгөний горим" className="grid grid-cols-3 gap-1 rounded-xl border border-line bg-surface2 p-1">
          {OPTIONS.map((o) => (
            <button key={o.v} type="button" role="radio" aria-checked={current === o.v} onClick={() => choose(o.v)}
              className={clsx('h-10 rounded-lg text-[13.5px] font-semibold', current === o.v ? 'bg-surface text-ink shadow-card' : 'text-muted')}>
              {o.l}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        <Button loading={busy === 'one'} onClick={() => out(false)}><Icon name="logout" size={16} /> Гарах</Button>
        <Button variant="danger" loading={busy === 'all'} onClick={() => out(true)}>Бүх төхөөрөмжөөс гарах</Button>
      </div>
    </div>
  );
}
