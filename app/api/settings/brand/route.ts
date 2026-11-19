import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { badRequest } from '@/lib/errors';
import { MAX_IMAGE_BYTES } from '@/lib/storage';
import { getBrandSettings, resetBrand, setBrandLogo, setBrandName } from '@/lib/services/brand';

export const dynamic = 'force-dynamic';

/** #177 Лого ба нэр (зөвхөн Супер админ — сервис дотор шалгана) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings' });
    return json(await getBrandSettings(ctx.actor));
  } catch (e) { return errorResponse(e); }
}
/** JSON { kind: 'name', name, dot } | { kind: 'reset' }; multipart file → лого */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings', need: 'edit' });
    if ((req.headers.get('content-type') ?? '').startsWith('multipart/')) {
      const len = Number(req.headers.get('content-length') ?? 0);
      if (len > MAX_IMAGE_BYTES + 64 * 1024) throw badRequest('Зураг 10MB-аас том байна', 'image_too_large');
      const file = (await req.formData().catch(() => null))?.get('file');
      if (!file || typeof file === 'string') throw badRequest('Зураг сонгоно уу', 'image_empty');
      await setBrandLogo(ctx.actor, Buffer.from(await file.arrayBuffer()));
    } else {
      const body = await req.json().catch(() => ({}));
      if (body.kind === 'reset') await resetBrand(ctx.actor);
      else await setBrandName(ctx.actor, body);
    }
    return json(await getBrandSettings(ctx.actor));
  } catch (e) { return errorResponse(e); }
}
