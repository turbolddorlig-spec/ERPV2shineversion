import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { updateCatalogItem } from '@/lib/services/catalog';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: { kind: string; id: string } }) {
  try {
    const ctx = await requireApiUser(req);
    const body = await req.json().catch(() => ({}));
    return json({ item: await updateCatalogItem(ctx.actor, params.kind, Number(params.id), body) });
  } catch (e) { return errorResponse(e); }
}
