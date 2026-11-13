import { NextResponse, type NextRequest } from 'next/server';
import { AppError, forbidden, unauthorized } from './errors';
import { resolveSession, SESSION_COOKIE, type SessionUser } from './session';
import { accessTo, type PageKey } from './permissions';
import { officeBlock } from './services/office';

export function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0]!.trim() : req.headers.get('x-real-ip')) || null;
}

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof AppError) return json({ error: e.message, code: e.code }, e.status);
  // Аудит #141: түгжээ хүлээх хугацаа хэтэрсэн (lock_timeout 55P03) / холболт дууссан (P2024) / гүйлгээ эхэлж амжаагүй (P2028, #146) — түр завгүй, дахин оролдоно
  const m = String((e as Error)?.message ?? '');
  if (/lock timeout|55P03|canceling statement due to lock timeout/i.test(m) || ['P2024', 'P2028', 'P2034'].includes(String((e as { code?: string })?.code)) || /deadlock detected|40P01|could not serialize/i.test(m)) {
    return json({ error: 'Систем түр завгүй байна — хэдэн секундийн дараа дахин дарна уу', code: 'busy' }, 409);
  }
  console.error('[api] unexpected error', e);
  return json({ error: 'Системийн алдаа гарлаа. Дахин оролдоно уу.', code: 'internal' }, 500);
}

/** CSRF хамгаалалт: өөрчлөлт хийх хүсэлт заавал өөрийн хаягаас ирсэн байх */
export function assertSameOrigin(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (!origin) return; // curl / сервер-сервер (cookie-гүй бол нэвтрэлт шаардлагаар хамгаалагдана)
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    if (new URL(origin).host !== host) throw forbidden('Хүсэлтийн эх сурвалж буруу');
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw forbidden('Хүсэлтийн эх сурвалж буруу');
  }
}

export interface ApiContext {
  user: SessionUser;
  sessionId: string;
  ip: string | null;
  actor: { id: string; name: string; roles: SessionUser['roles']; ip: string | null };
}

export async function requireApiUser(
  req: NextRequest,
  opts: { page?: PageKey; need?: 'view' | 'edit'; allowMustChange?: boolean; allowOutsideOffice?: boolean } = {},
): Promise<ApiContext> {
  if (req.method !== 'GET' && req.method !== 'HEAD') assertSameOrigin(req);
  const r = await resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!r) throw unauthorized();
  if (r.user.mustChangePassword && !opts.allowMustChange) throw new AppError(403, 'Эхлээд нууц үгээ солино уу', 'must_change_password');
  if (!opts.allowOutsideOffice) {
    const office = await officeBlock(r.user.roles, clientIp(req));
    if (office) throw new AppError(403, office, 'office_only');
  }
  if (opts.page) {
    const a = accessTo(r.user.roles, opts.page);
    if (a === 'none' || (opts.need === 'edit' && a !== 'edit')) throw forbidden();
  }
  const ip = clientIp(req);
  return { user: r.user, sessionId: r.sessionId, ip, actor: { id: r.user.id, name: r.user.name, roles: r.user.roles, ip } };
}

export function sessionCookie(token: string, expires: Date) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== 'false',
    sameSite: 'lax' as const,
    path: '/',
    expires,
  };
}

export function themeCookie(theme: string) {
  return { name: 'theme', value: theme.toLowerCase(), path: '/', sameSite: 'lax' as const, maxAge: 60 * 60 * 24 * 365, httpOnly: false };
}
