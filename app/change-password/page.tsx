import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/current-user';
import { ChangePasswordForm } from '@/components/ChangePasswordForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Нууц үг солих · zahialga•' };

export default async function ChangePasswordPage() {
  const s = await currentSession();
  if (!s) redirect('/login');
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <h1 className="mb-2 text-[24px] font-extrabold tracking-[-0.03em]">Нууц үгээ солино уу</h1>
        <p className="mb-5 text-[14px] text-muted">
          {s.user.mustChangePassword
            ? 'Танд түр нууц үг олгогдсон. Үргэлжлүүлэхийн өмнө өөрийн шинэ нууц үгийг тохируулна уу.'
            : 'Шинэ нууц үгээ оруулна уу.'}
        </p>
        <ChangePasswordForm redirectAfter />
      </div>
    </main>
  );
}
