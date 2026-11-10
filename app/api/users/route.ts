import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { createUser, listUsers } from '@/lib/services/users';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'users' });
    const sp = req.nextUrl.searchParams;
    const status = sp.get('status');
    const data = await listUsers(ctx.actor, {
      q: sp.get('q') ?? undefined,
      role: sp.get('role') ?? undefined,
      status: status === 'inactive' || status === 'locked' || status === 'all' ? status : 'active',
      page: Number(sp.get('page') ?? 1) || 1,
    });
    return json(data);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'users', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    const r = await createUser(ctx.actor, body);
    return json(r, 201);
  } catch (e) {
    return errorResponse(e);
  }
}
