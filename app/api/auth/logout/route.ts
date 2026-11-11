import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { logout } from '@/lib/services/auth';
import { SESSION_COOKIE } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { allowMustChange: true, allowOutsideOffice: true });
    await logout(ctx.sessionId, ctx.actor);
    const res = json({ ok: true });
    res.cookies.delete(SESSION_COOKIE);
    return res;
  } catch (e) {
    const res = errorResponse(e);
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }
}
