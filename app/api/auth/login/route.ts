import type { NextRequest } from 'next/server';
import { assertSameOrigin, clientIp, errorResponse, json, sessionCookie, themeCookie } from '@/lib/http';
import { login } from '@/lib/services/auth';
import { homeFor } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const body = await req.json().catch(() => ({}));
    const r = await login(String(body.phone ?? ''), String(body.password ?? ''), {
      ip: clientIp(req),
      userAgent: req.headers.get('user-agent'),
    });
    const res = json({ ok: true, next: r.user.mustChangePassword ? '/change-password' : homeFor(r.user.roles) });
    res.cookies.set(sessionCookie(r.token, r.expiresAt));
    res.cookies.set(themeCookie(r.user.theme));
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
