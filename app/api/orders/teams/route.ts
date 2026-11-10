import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { getOperatorTeams, setOperatorTeams } from '@/lib/services/orders/admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders' });
    return json(await getOperatorTeams(ctx.actor));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders', need: 'edit' });
    return json(await setOperatorTeams(ctx.actor, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
