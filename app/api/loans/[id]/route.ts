import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { getLoan } from '@/lib/services/stock/loans';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'loans' });
    return json({ loan: await getLoan(ctx.actor, params.id) });
  } catch (e) { return errorResponse(e); }
}
