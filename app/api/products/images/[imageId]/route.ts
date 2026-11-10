import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { deleteProductImage, updateProductImage } from '@/lib/services/product-images';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: { imageId: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'products', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    return json(await updateProductImage(ctx.actor, params.imageId, body));
  } catch (e) { return errorResponse(e); }
}

export async function DELETE(req: NextRequest, { params }: { params: { imageId: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'products', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    return json(await deleteProductImage(ctx.actor, params.imageId, body.reason));
  } catch (e) { return errorResponse(e); }
}
