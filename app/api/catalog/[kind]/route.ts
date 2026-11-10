import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { createCatalogItem, listCatalog } from '@/lib/services/catalog';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { kind: string } }) {
  try {
    const ctx = await requireApiUser(req);
    return json({ items: await listCatalog(ctx.actor, params.kind) });
  } catch (e) { return errorResponse(e); }
}

export async function POST(req: NextRequest, { params }: { params: { kind: string } }) {
  try {
    const ctx = await requireApiUser(req);
    const body = await req.json().catch(() => ({}));
    return json({ item: await createCatalogItem(ctx.actor, params.kind, body) }, 201);
  } catch (e) { return errorResponse(e); }
}
