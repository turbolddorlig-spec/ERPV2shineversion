import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { markPaidCancelReviewed, paidCancelledList } from '@/lib/services/accounting/bank';

export const dynamic = 'force-dynamic';

/** Аудит #155: төлсөн ч жолооч / асуудлаар цуцлагдсан захиалга — зөвхөн Супер админ */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'bank-import' });
    return json(await paidCancelledList(ctx.actor));
  } catch (e) { return errorResponse(e); }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'bank-import' });
    const b = (await req.json().catch(() => ({}))) as { id?: unknown; note?: unknown };
    return json(await markPaidCancelReviewed(ctx.actor, b.id, b.note));
  } catch (e) { return errorResponse(e); }
}
