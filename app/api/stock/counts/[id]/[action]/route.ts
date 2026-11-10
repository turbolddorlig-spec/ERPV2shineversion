import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { notFound } from '@/lib/errors';
import { cancelCount, decideCount, setCountLine, submitCount } from '@/lib/services/stock/counts';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    if (params.action === 'line') return json({ line: await setCountLine(ctx.actor, params.id, body) });
    if (params.action === 'submit') return json({ count: await submitCount(ctx.actor, params.id) });
    if (params.action === 'decide') return json(await decideCount(ctx.actor, params.id, body));
    if (params.action === 'cancel') return json({ count: await cancelCount(ctx.actor, params.id) });
    throw notFound();
  } catch (e) { return errorResponse(e); }
}
