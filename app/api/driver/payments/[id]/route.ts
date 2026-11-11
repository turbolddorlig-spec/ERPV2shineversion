import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { deleteDriverPayment } from '@/lib/services/accounting/settle';

export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver', need: 'edit' });
    return json(await deleteDriverPayment(ctx.actor, params.id));
  } catch (e) { return errorResponse(e); }
}
