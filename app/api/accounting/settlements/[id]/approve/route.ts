import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { approveSettlement } from '@/lib/services/accounting/settle';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'accounting', need: 'edit' });
    return json(await approveSettlement(ctx.actor, params.id));
  } catch (e) { return errorResponse(e); }
}
