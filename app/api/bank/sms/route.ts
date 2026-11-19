import type { NextRequest } from 'next/server';
import { receiveSms } from '@/lib/services/accounting/bank-sms';

export const dynamic = 'force-dynamic';

/** #181 MacroDroid «HTTP Request» (POST): ?key=… ; body = мессежийн текст (text/plain) эсвэл JSON {"text": "…"} эсвэл form text=… */
export async function POST(req: NextRequest) {
  try {
    const key = req.nextUrl.searchParams.get('key') ?? req.headers.get('x-key') ?? '';
    const ct = req.headers.get('content-type') ?? '';
    const raw = (await req.text()).slice(0, 4000);
    let text = raw;
    if (ct.includes('application/json')) { try { const j = JSON.parse(raw) as { text?: unknown; message?: unknown }; text = String(j.text ?? j.message ?? ''); } catch { text = ''; } }
    else if (ct.includes('application/x-www-form-urlencoded')) text = new URLSearchParams(raw).get('text') ?? '';
    const r = await receiveSms(key, text);
    return Response.json(r.body, { status: r.status });
  } catch {
    return Response.json({ ok: false, error: 'Алдаа' }, { status: 500 });
  }
}
