'use client';
import { useEffect, useState } from 'react';
import { Icon } from '../icons';

function effectiveDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Light/Dark солих — хэрэглэгч бүрийн сонголт database-д хадгалагдана */
export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(effectiveDark()), []);
  async function toggle() {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setDark(!dark);
    try {
      await fetch('/api/me/theme', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: next }) });
    } catch { /* сүлжээгүй үед ч дэлгэц дээр солигдсон хэвээр */ }
  }
  return (
    <button type="button" onClick={toggle} aria-label={dark ? 'Light горим руу шилжих' : 'Dark горим руу шилжих'}
      className={className ?? 'grid h-11 w-11 place-items-center rounded-xl border border-line bg-surface text-ink'}>
      <Icon name={dark ? 'sun' : 'moon'} />
    </button>
  );
}
