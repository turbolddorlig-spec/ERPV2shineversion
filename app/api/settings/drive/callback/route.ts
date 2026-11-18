import { NextResponse, type NextRequest } from 'next/server';
import { requireApiUser } from '@/lib/http';
import { AppError } from '@/lib/errors';
import { driveCallback } from '@/lib/services/drive-backup';

export const dynamic = 'force-dynamic';

/** Google-ээс буцах хаяг — үр дүнг Тохиргоо хуудсанд харуулна */
export async function GET(req: NextRequest) {
  const base = (process.env.APP_URL || req.nextUrl.origin).replace(/\/$/, '');
  const back = (q: Record<string, string>) => NextResponse.redirect(`${base}/settings?${new URLSearchParams(q).toString()}#drive`);
  try {
    const ctx = await requireApiUser(req, { page: 'settings', need: 'edit' });
    const p = req.nextUrl.searchParams;
    const r = await driveCallback(ctx.actor, { code: p.get('code'), state: p.get('state'), error: p.get('error') }, req.nextUrl.origin);
    return back({ drive: 'ok', email: r.email });
  } catch (e) {
    return back({ drive: 'error', msg: e instanceof AppError ? e.message : 'Холбогдсонгүй — дахин оролдоно уу' });
  }
}
