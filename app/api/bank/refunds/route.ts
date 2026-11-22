import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { notFound } from '@/lib/errors';
import { completeRefundRequest, createRefundRequest, listRefundRequests, rejectRefundRequest } from '@/lib/services/accounting/refunds';

export const dynamic = 'force-dynamic';

/** #211: мөнгө буцаах хүсэлт — жагсаалт */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'bank-import' });
    const sp = req.nextUrl.searchParams;
    return json(await listRefundRequests(ctx.actor, { status: sp.get('status') ?? undefined, page: Number(sp.get('page')) || 1 }));
  } catch (e) { return errorResponse(e); }
}

/** action: create { kind, id, bankName, accountNo, accountName, reason } · done { id } · reject { id, note } — эрхийг үйлчилгээ шалгана */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'bank-import' });
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (b.action === 'create') return json(await createRefundRequest(ctx.actor, b));
    if (b.action === 'done') return json(await completeRefundRequest(ctx.actor, b.id));
    if (b.action === 'reject') return json(await rejectRefundRequest(ctx.actor, b.id, b.note));
    throw notFound();
  } catch (e) { return errorResponse(e); }
}
