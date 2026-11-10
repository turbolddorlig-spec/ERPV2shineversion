import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { changeOwnPassword } from '@/lib/services/auth';
import { homeFor } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { allowMustChange: true });
    const body = await req.json().catch(() => ({}));
    await changeOwnPassword(ctx.actor, ctx.sessionId, String(body.currentPassword ?? ''), String(body.newPassword ?? ''));
    return json({ ok: true, next: homeFor(ctx.user.roles) });
  } catch (e) {
    return errorResponse(e);
  }
}
