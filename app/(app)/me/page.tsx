import { requireUser } from '@/lib/current-user';
import { ROLE_LABEL } from '@/lib/roles';
import { formatPhone } from '@/lib/phone';
import { PageHeader } from '@/components/shell/AppShell';
import { Badge } from '@/components/ui/Badge';
import { ChangePasswordForm } from '@/components/ChangePasswordForm';
import { MeActions } from './MeActions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Миний мэдээлэл · zahialga•' };

export default async function MePage() {
  const user = await requireUser();
  return (
    <>
      <PageHeader title="Миний мэдээлэл" />
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-4 rounded-[18px] border border-line bg-surface p-5 shadow-card">
          <div>
            <p className="text-[20px] font-extrabold">{user.name}</p>
            <p className="text-[14px] text-muted">{formatPhone(user.phone)}</p>
          </div>
          <div className="flex flex-wrap gap-1.5">{user.roles.map((r) => <Badge key={r} tone="accent">{ROLE_LABEL[r]}</Badge>)}</div>
          <MeActions theme={user.theme} />
        </section>
        <section className="flex flex-col gap-3">
          <h2 className="text-[17px] font-extrabold">Нууц үг солих</h2>
          <ChangePasswordForm />
        </section>
      </div>
    </>
  );
}
