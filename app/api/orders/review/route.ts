import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { discountReviewList, reviewDiscounts } from '@/lib/services/orders/queries';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders' });
    const sp = req.nextUrl.searchParams;
    return json(await discountReviewList(ctx.actor, { unreviewed: sp.get('unreviewed') === '1', page: Number(sp.get('page')) || 1 }));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders' });
    const body = await req.json().catch(() => ({}));
    return json(await reviewDiscounts(ctx.actor, body.ids));
  } catch (e) { return errorResponse(e); }
}
