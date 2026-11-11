import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { cancelPenalty, setDeducted } from '@/lib/services/penalties';
import { notFound } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/** cancel { note } · deduct */
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'penalties' });
    const body = await req.json().catch(() => ({}));
    if (params.action === 'cancel') return json(await cancelPenalty(ctx.actor, params.id, body));
    if (params.action === 'deduct') return json(await setDeducted(ctx.actor, params.id));
    throw notFound();
  } catch (e) { return errorResponse(e); }
}
