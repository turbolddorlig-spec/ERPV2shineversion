import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { listTransactions } from '@/lib/services/accounting/bank';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'bank-import' });
    const sp = req.nextUrl.searchParams;
    return json(await listTransactions(ctx.actor, { tab: sp.get('tab') ?? undefined, q: sp.get('q') ?? undefined, from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined, page: Number(sp.get('page') ?? 1) }));
  } catch (e) { return errorResponse(e); }
}
