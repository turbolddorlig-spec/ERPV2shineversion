import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { listLoans, requestLoan } from '@/lib/services/stock/loans';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'loans' });
    const sp = req.nextUrl.searchParams;
    return json(await listLoans(ctx.actor, { status: sp.get('status') ?? undefined, mine: sp.get('mine') === '1', page: Number(sp.get('page')) || 1 }));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'loans', need: 'edit' });
    const r = await requestLoan(ctx.actor, await req.json().catch(() => ({})));
    return json(r, r.duplicate ? 200 : 201);
  } catch (e) { return errorResponse(e); }
}
