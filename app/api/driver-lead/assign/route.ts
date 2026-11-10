import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { assignOrders, setDeliveryDate } from '@/lib/services/delivery/assign';

export const dynamic = 'force-dynamic';

/** { ids, driverId } — хуваарилах; { ids, date } — огноо солих */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver-lead', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    if (body.date !== undefined) return json(await setDeliveryDate(ctx.actor, body));
    return json(await assignOrders(ctx.actor, body));
  } catch (e) { return errorResponse(e); }
}
