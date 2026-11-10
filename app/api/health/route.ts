import { db } from '@/lib/db';
import { json } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return json({ ok: true, db: 'ok', time: new Date().toISOString() });
  } catch {
    return json({ ok: false, db: 'down' }, 503);
  }
}
