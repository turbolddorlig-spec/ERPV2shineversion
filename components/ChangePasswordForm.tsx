'use client';
import { useState } from 'react';
import { Field } from './ui/Field';
import { Button } from './ui/Button';
import { Notice } from './ui/Notice';
import { api, ApiError } from './ui/api';

export function ChangePasswordForm({ redirectAfter }: { redirectAfter?: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== repeat) { setError('Шинэ нууц үг давтсантай таарахгүй байна'); return; }
    setLoading(true);
    try {
      const r = await api<{ next: string }>('/api/auth/change-password', { method: 'POST', json: { currentPassword: current, newPassword: next } });
      if (redirectAfter) { window.location.href = r.next; return; }
      setDone(true); setCurrent(''); setNext(''); setRepeat('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Алдаа гарлаа');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-[18px] border border-line bg-surface p-5 shadow-card" noValidate>
      {error ? <Notice>{error}</Notice> : null}
      {done ? <Notice tone="ok">Нууц үг солигдлоо. Бусад төхөөрөмжөөс гаргалаа.</Notice> : null}
      <Field id="cur" label="Одоогийн (эсвэл түр) нууц үг" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      <Field id="new" label="Шинэ нууц үг" type="password" autoComplete="new-password" hint="Дор хаяж 6 тэмдэгт" value={next} onChange={(e) => setNext(e.target.value)} />
      <Field id="rep" label="Шинэ нууц үгээ давтах" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full">Нууц үг солих</Button>
    </form>
  );
}
