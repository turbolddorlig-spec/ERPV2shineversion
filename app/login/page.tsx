import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/current-user';
import { homeFor } from '@/lib/permissions';
import { LoginForm } from './LoginForm';
import { getBrand, logoUrl } from '@/lib/services/brand';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Нэвтрэх' };

export default async function LoginPage() {
  const s = await currentSession();
  if (s) redirect(s.user.mustChangePassword ? '/change-password' : homeFor(s.user.roles));
  const b = await getBrand(); const logo = logoUrl(b);
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          {logo ? <img src={logo} alt={b.name} className="h-14 w-14 rounded-2xl bg-white object-cover" />
            : <span className="grid h-14 w-14 place-items-center rounded-2xl bg-[#E8590C] text-[30px] font-extrabold tracking-[-0.04em] text-white">{(b.name.trim()[0] ?? 'z').toLowerCase()}<span className="text-[#16181D]">.</span></span>}
          <h1 className="max-w-full text-[28px] font-extrabold tracking-[-0.035em] [overflow-wrap:anywhere]">{b.name}{b.dot ? <span className="text-accent">•</span> : null}</h1>
          <p className="text-[14px] text-muted">Утасны дугаар, нууц үгээрээ нэвтэрнэ үү</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
