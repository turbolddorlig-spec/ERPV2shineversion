import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { resolveDebt } from '@/lib/services/accounting/debts';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'accounting', need: 'edit' });
    return json(await resolveDebt(ctx.actor, params.id, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
