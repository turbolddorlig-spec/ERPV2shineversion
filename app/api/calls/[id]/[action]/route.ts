import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { notFound } from '@/lib/errors';
import { attemptCall, closeCallNote, requestTransfer, suggestCloseReason } from '@/lib/services/orders/calls';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders', need: 'edit' });
    if (params.action !== 'suggest') throw notFound();
    return json(await suggestCloseReason(ctx.actor, params.id));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    switch (params.action) {
      case 'attempt': return json(await attemptCall(ctx.actor, params.id));
      case 'close': return json({ note: await closeCallNote(ctx.actor, params.id, body) });
      case 'transfer': return json({ transfer: await requestTransfer(ctx.actor, params.id, body) });
      default: throw notFound();
    }
  } catch (e) { return errorResponse(e); }
}
