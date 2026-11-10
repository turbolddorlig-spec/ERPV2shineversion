import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { listProductHistory, unreviewedCount } from '@/lib/services/product-history';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req);
    const sp = req.nextUrl.searchParams;
    const data = await listProductHistory(ctx.actor, {
      productId: Number(sp.get('productId')) || undefined,
      actorId: sp.get('actorId') || undefined,
      from: sp.get('from') || undefined,
      to: sp.get('to') || undefined,
      important: sp.get('important') === '1',
      unreviewed: sp.get('unreviewed') === '1',
      page: Number(sp.get('page')) || 1,
    });
    return json({ ...data, unreviewed: await unreviewedCount(ctx.actor, { fresh: true }) });
  } catch (e) { return errorResponse(e); }
}
