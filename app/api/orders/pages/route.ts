import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { pagesForActor } from '@/lib/services/orders/admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req);
    return json(await pagesForActor(ctx.actor));
  } catch (e) { return errorResponse(e); }
}
