import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { addProductImage } from '@/lib/services/product-images';
import { badRequest } from '@/lib/errors';
import { MAX_IMAGE_BYTES } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/** multipart: file, color, reason */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'products', need: 'edit' });
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > MAX_IMAGE_BYTES + 64 * 1024) throw badRequest('Зураг 10MB-аас том байна', 'image_too_large');
    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!file || typeof file === 'string') throw badRequest('Зураг сонгоно уу', 'image_empty');
    const buf = Buffer.from(await file.arrayBuffer());
    return json({ image: await addProductImage(ctx.actor, Number(params.id), buf, { color: form?.get('color'), reason: form?.get('reason') }) }, 201);
  } catch (e) { return errorResponse(e); }
}
