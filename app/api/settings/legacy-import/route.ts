import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { legacyCommit, legacyPreview } from '@/lib/services/legacy-import';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Туршилтын оруулалт (#138) — зөвхөн Супер админ (сервис дотор шалгана). action: preview | commit */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    if (body.action === 'commit') return json(await legacyCommit(ctx.actor, body));
    return json(await legacyPreview(ctx.actor, body));
  } catch (e) {
    const steps = (e as { steps?: string[] }).steps;
    const res = errorResponse(e);
    if (!steps?.length) return res;
    const data = await res.json();
    return json({ ...data, steps }, res.status);
  }
}
