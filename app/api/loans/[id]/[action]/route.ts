import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { notFound } from '@/lib/errors';
import { cancelLoan, chargeLoan, issueLoan, rejectLoan, returnLoan, setLoanDeduction } from '@/lib/services/stock/loans';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'loans', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    switch (params.action) {
      case 'cancel': return json({ loan: await cancelLoan(ctx.actor, params.id) });
      case 'reject': return json({ loan: await rejectLoan(ctx.actor, params.id, body) });
      case 'issue': return json(await issueLoan(ctx.actor, params.id, body));
      case 'return': return json(await returnLoan(ctx.actor, params.id, body));
      case 'deduction': return json({ loan: await setLoanDeduction(ctx.actor, params.id, body) });
      case 'charge': return json(await chargeLoan(ctx.actor, params.id, body));
      default: throw notFound();
    }
  } catch (e) { return errorResponse(e); }
}
