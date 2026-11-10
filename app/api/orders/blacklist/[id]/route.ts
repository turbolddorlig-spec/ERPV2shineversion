import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { removeBlacklist } from '@/lib/services/orders/admin';

export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders', need: 'edit' });
    return json({ entry: await removeBlacklist(ctx.actor, params.id, await req.json().catch(() => ({}))) });
  } catch (e) { return errorResponse(e); }
}
