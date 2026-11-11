import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { approveDriverPayment } from '@/lib/services/accounting/settle';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'accounting', need: 'edit' });
    return json(await approveDriverPayment(ctx.actor, params.id, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
