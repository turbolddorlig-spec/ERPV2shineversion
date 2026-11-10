import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { notFound } from '@/lib/errors';
import { cancelOrder, extendDeadline, markPaid, undoPaid } from '@/lib/services/orders/orders';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    switch (params.action) {
      case 'cancel': return json(await cancelOrder(ctx.actor, params.id, body));
      case 'paid': return json(await markPaid(ctx.actor, params.id));
      case 'unpaid': return json(await undoPaid(ctx.actor, params.id, body));
      case 'extend': return json(await extendDeadline(ctx.actor, params.id, body));
      default: throw notFound();
    }
  } catch (e) { return errorResponse(e); }
}
