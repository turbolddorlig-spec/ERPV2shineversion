import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { manualMatch, refundExcess, setRefunded } from '@/lib/services/accounting/bank';
import { notFound } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/** match { orderNumber } · refund { refunded } */
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'bank-import', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    if (params.action === 'match') return json(await manualMatch(ctx.actor, params.id, body));
    if (params.action === 'refund') return json(await setRefunded(ctx.actor, params.id, body));
    if (params.action === 'refund-excess') return json(await refundExcess(ctx.actor, params.id));
    throw notFound();
  } catch (e) { return errorResponse(e); }
}
