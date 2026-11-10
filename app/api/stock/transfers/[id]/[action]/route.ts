import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { notFound } from '@/lib/errors';
import { cancelTransfer, receiveTransfer, resolveTransfer } from '@/lib/services/stock/transfers';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    if (params.action === 'receive') return json(await receiveTransfer(ctx.actor, params.id, body));
    if (params.action === 'cancel') return json(await cancelTransfer(ctx.actor, params.id, body));
    if (params.action === 'resolve') return json(await resolveTransfer(ctx.actor, params.id, body));
    throw notFound();
  } catch (e) { return errorResponse(e); }
}
