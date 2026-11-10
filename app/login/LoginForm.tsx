'use client';
import { useState } from 'react';
import { Field } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';

export function LoginForm() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, password }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? 'Нэвтэрч чадсангүй'); setLoading(false); return; }
      window.location.href = data.next ?? '/';
    } catch {
      setError('Сүлжээний алдаа. Интернэтээ шалгаад дахин оролдоно уу.');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-[18px] border border-line bg-surface p-5 shadow-pop" noValidate>
      {error ? <Notice>{error}</Notice> : null}
      <Field id="phone" label="Утасны дугаар" inputMode="numeric" autoComplete="username" placeholder="9911 2233"
        value={phone} onChange={(e) => setPhone(e.target.value)} required maxLength={12} />
      <Field id="password" label="Нууц үг" type="password" autoComplete="current-password"
        value={password} onChange={(e) => setPassword(e.target.value)} required />
      <Button type="submit" variant="primary" size="lg" loading={loading} className="mt-1 w-full">Нэвтрэх</Button>
    </form>
  );
}
