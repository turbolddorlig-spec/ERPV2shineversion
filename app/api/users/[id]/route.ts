import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { updateUser } from '@/lib/services/users';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'users', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    const user = await updateUser(ctx.actor, params.id, { name: body.name, phone: body.phone, roles: body.roles });
    return json({ user });
  } catch (e) {
    return errorResponse(e);
  }
}
