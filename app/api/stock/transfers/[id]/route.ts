import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { getTransfer } from '@/lib/services/stock/transfers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse' });
    return json({ transfer: await getTransfer(ctx.actor, params.id) });
  } catch (e) { return errorResponse(e); }
}
