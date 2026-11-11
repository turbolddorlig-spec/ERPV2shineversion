'use client';

export function OfficeLogout() {
  const out = async () => { await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined); window.location.href = '/login'; };
  return <button onClick={() => void out()} className="mt-5 inline-flex h-11 items-center rounded-xl bg-ink px-5 font-bold text-on-ink">Гарах</button>;
}
