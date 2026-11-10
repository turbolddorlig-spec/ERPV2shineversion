import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { reconcile } from '@/lib/services/stock/views';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse' });
    return json(await reconcile(ctx.actor, { fresh: req.nextUrl.searchParams.get('fresh') === '1' }));
  } catch (e) { return errorResponse(e); }
}
