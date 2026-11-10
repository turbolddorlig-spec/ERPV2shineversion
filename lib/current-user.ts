import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { resolveSession, SESSION_COOKIE } from './session';
import { accessTo, type PageKey } from './permissions';

/** Server component-д: нэвтэрсэн хэрэглэгч (нэг хүсэлтэд нэг удаа уншина) */
export const currentSession = cache(async () => resolveSession(cookies().get(SESSION_COOKIE)?.value));

export async function requireUser() {
  const s = await currentSession();
  if (!s) redirect('/login');
  if (s.user.mustChangePassword) redirect('/change-password');
  return s.user;
}

export async function requirePage(key: PageKey) {
  const user = await requireUser();
  const access = accessTo(user.roles, key);
  if (access === 'none') redirect('/forbidden');
  return { user, access };
}
