import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser, themeCookie } from '@/lib/http';
import { setTheme } from '@/lib/services/auth';
import { badRequest } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { allowMustChange: true });
    const body = await req.json().catch(() => ({}));
    const theme = String(body.theme ?? '').toUpperCase();
    if (theme !== 'LIGHT' && theme !== 'DARK' && theme !== 'SYSTEM') throw badRequest('Горим буруу');
    await setTheme(ctx.actor, theme);
    const res = json({ ok: true });
    res.cookies.set(themeCookie(theme));
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
