import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { activateUser, deactivateUser, resetPassword, unlockUser } from '@/lib/services/users';
import { notFound } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'users', need: 'edit' });
    switch (params.action) {
      case 'deactivate': return json({ user: await deactivateUser(ctx.actor, params.id) });
      case 'activate': return json({ user: await activateUser(ctx.actor, params.id) });
      case 'reset-password': return json(await resetPassword(ctx.actor, params.id));
      case 'unlock': return json({ user: await unlockUser(ctx.actor, params.id) });
      default: throw notFound();
    }
  } catch (e) {
    return errorResponse(e);
  }
}
