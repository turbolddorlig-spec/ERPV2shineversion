import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { customerCard } from '@/lib/services/orders/queries';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders' });
    return json(await customerCard(ctx.actor, req.nextUrl.searchParams.getAll('phone')));
  } catch (e) { return errorResponse(e); }
}
