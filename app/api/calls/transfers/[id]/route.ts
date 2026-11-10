import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { decideTransfer } from '@/lib/services/orders/calls';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders', need: 'edit' });
    return json({ transfer: await decideTransfer(ctx.actor, params.id, await req.json().catch(() => ({}))) });
  } catch (e) { return errorResponse(e); }
}
