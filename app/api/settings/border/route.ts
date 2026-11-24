import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { forbidden } from '@/lib/errors';
import { getBorder, setBorder } from '@/lib/services/border';

export const dynamic = 'force-dynamic';

/** #214: Замын-Үүдийн хил хаагдах өдрүүд — Супер админ */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings' });
    if (!ctx.actor.roles.includes('SUPER_ADMIN')) throw forbidden('Зөвхөн Супер админ');
    return json(await getBorder());
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings' });
    return json(await setBorder(ctx.actor, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
