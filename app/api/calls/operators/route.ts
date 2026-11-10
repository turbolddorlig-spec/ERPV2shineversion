import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { operatorsList } from '@/lib/services/orders/calls';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders' });
    return json({ items: await operatorsList(ctx.actor) });
  } catch (e) { return errorResponse(e); }
}
