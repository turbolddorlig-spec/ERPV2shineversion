import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { setProductStatus } from '@/lib/services/products';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'products', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    return json({ product: await setProductStatus(ctx.actor, Number(params.id), body) });
  } catch (e) { return errorResponse(e); }
}
