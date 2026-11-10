import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { updateWarehouse } from '@/lib/services/stock/warehouses';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse', need: 'edit' });
    return json({ warehouse: await updateWarehouse(ctx.actor, params.id, await req.json().catch(() => ({}))) });
  } catch (e) { return errorResponse(e); }
}
