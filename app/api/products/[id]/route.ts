import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { getProduct, updateProduct } from '@/lib/services/products';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'products' });
    return json({ product: await getProduct(ctx.actor, Number(params.id)) });
  } catch (e) { return errorResponse(e); }
}

/** Засвар: body = { changes: {...}, reason, version } */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'products', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    return json(await updateProduct(ctx.actor, Number(params.id), body.changes ?? {}, { reason: body.reason, version: body.version }));
  } catch (e) { return errorResponse(e); }
}
