import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { reviewProductEdit } from '@/lib/services/product-history';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { auditId: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'product-history', need: 'edit' });
    return json({ review: await reviewProductEdit(ctx.actor, params.auditId) });
  } catch (e) { return errorResponse(e); }
}
