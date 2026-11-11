import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { penaltyConfig, saveCategory, setAutoAmounts } from '@/lib/services/penalties';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req);
    return json(await penaltyConfig(ctx.actor));
  } catch (e) { return errorResponse(e); }
}
/** { action: 'category', id?, type, name, defaultAmount, active, lateMinutes } | { action: 'auto', OPP_ERROR, MARKETING_ERROR, WAREHOUSE_ERROR } */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req);
    const body = await req.json().catch(() => ({}));
    if (body.action === 'auto') return json(await setAutoAmounts(ctx.actor, body));
    return json(await saveCategory(ctx.actor, body));
  } catch (e) { return errorResponse(e); }
}
