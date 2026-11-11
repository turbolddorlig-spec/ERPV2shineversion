import type { NextRequest } from 'next/server';
import { clientIp, errorResponse, json, requireApiUser } from '@/lib/http';
import { officeView, setOffice } from '@/lib/services/office';

export const dynamic = 'force-dynamic';

/** «Зөвхөн ажлын байрнаас» тохиргоо — ролиуд, ажлын IP; одоогийн IP-г буцаана («Одоогийн IP-г нэмэх») */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings' });
    return json(await officeView(ctx.actor, clientIp(req)));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings', need: 'edit' });
    return json(await setOffice(ctx.actor, await req.json().catch(() => ({})), clientIp(req)));
  } catch (e) { return errorResponse(e); }
}
