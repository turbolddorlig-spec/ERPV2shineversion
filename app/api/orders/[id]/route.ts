import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { updateOrder } from '@/lib/services/orders/orders';
import { getOrder } from '@/lib/services/orders/queries';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders' });
    return json({ order: await getOrder(ctx.actor, params.id) });
  } catch (e) { return errorResponse(e); }
}
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders', need: 'edit' });
    return json(await updateOrder(ctx.actor, params.id, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
