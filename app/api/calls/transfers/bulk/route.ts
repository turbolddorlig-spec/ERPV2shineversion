import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { decideTransfers } from '@/lib/services/orders/calls';

export const dynamic = 'force-dynamic';

/** { ids: number[] | 'all', accept: boolean } — ирсэн хүсэлтүүдийг бөөнөөр */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders', need: 'edit' });
    return json(await decideTransfers(ctx.actor, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
