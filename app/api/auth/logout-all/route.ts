import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { logoutEverywhere } from '@/lib/services/auth';
import { SESSION_COOKIE } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { allowMustChange: true });
    await logoutEverywhere(ctx.actor);
    const res = json({ ok: true });
    res.cookies.delete(SESSION_COOKIE);
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
