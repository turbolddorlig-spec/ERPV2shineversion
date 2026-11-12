import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, forbidden } from '../../errors';
import { writeAudit } from '../../audit';
import { canManageOrderSettings } from '../../permissions';
import type { UserActor } from '../users';

/**
 * Meta Conversions API — Purchase (#7, #43 5, MASTER §7).
 * - Зөвхөн баталгаажсан захиалгад, НЭГ л удаа (MetaEvent.orderId давтагдашгүй; event_id = захиалгын дугаар).
 * - Гүйлгээнд дараалалд орно → арын ажил илгээнэ; алдаа гарвал 1м, 5м, 15м, 1ц, 6ц… дахин оролдоно, логтой.
 * - Pixel ID, Access Token-ийг Тохиргоонд хадгална; токен хэзээ ч хариунд гарахгүй (сүүлийн 4 тэмдэгт л).
 * - Хуучин шиг операторын хөтчийн IP/UA илгээхгүй (үйлчлүүлэгчийнх биш тул).
 */
const KEYS = { pixel: 'metaPixelId', token: 'metaAccessToken', test: 'metaTestEventCode' } as const;
const BACKOFF_MIN = [1, 5, 15, 60, 360, 720, 1440];
const MAX_ATTEMPTS = 8;
const GRAPH = () => process.env.META_GRAPH_URL ?? 'https://graph.facebook.com/v19.0';

const sha = (s: string) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

async function readConfig(tx: Prisma.TransactionClient | typeof db = db) {
  const rows = await tx.appSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  const m = new Map(rows.map((r) => [r.key, typeof r.value === 'string' ? r.value : String(r.value ?? '')]));
  return { pixelId: m.get(KEYS.pixel) || '', token: m.get(KEYS.token) || '', testCode: m.get(KEYS.test) || '' };
}

/** Баталгаажсан захиалгыг дараалалд оруулна. Pixel тохируулаагүй бол SKIPPED (дараа нь тохируулахад хуучнууд үерлэхгүй). */
export async function enqueueMeta(tx: Prisma.TransactionClient, orderId: number) {
  const cfg = await readConfig(tx);
  const on = !!(cfg.pixelId && cfg.token);
  await tx.metaEvent.createMany({ data: [{ orderId, status: on ? 'PENDING' : 'SKIPPED' }], skipDuplicates: true });
  // «Мөнгө орсон»-ыг буцаагаад дахин төлөгдсөн (#124-5): алгассан event-ийг сэргээнэ. Илгээгдсэнийг дахин илгээхгүй — нэг л удаа
  if (on) await tx.metaEvent.updateMany({ where: { orderId, status: 'SKIPPED' }, data: { status: 'PENDING', lastError: null } });
}
/** Цуцлах / «Мөнгө орсон» буцаахад: илгээгдээгүй event-ийг алгасна (илгээгдсэнийг Meta буцаах боломжгүй) */
export async function skipMeta(tx: Prisma.TransactionClient, orderId: number) {
  await tx.metaEvent.updateMany({ where: { orderId, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'SKIPPED', lastError: 'Захиалга цуцлагдсан / төлбөр буцаагдсан' } });
}

function payload(o: Prisma.OrderGetPayload<{ include: { lines: true } }>, testCode: string) {
  const phones = [o.phone, o.extraPhone].filter((x): x is string => !!x).map((p) => sha(`976${p}`));
  return {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor((o.confirmedAt ?? o.createdAt).getTime() / 1000),
      event_id: `order_${o.number}`,
      action_source: 'chat',
      user_data: {
        ph: phones, country: [sha('mn')], st: [sha(o.province)], ...(o.district ? { ct: [sha(o.district)] } : {}),
        external_id: [sha(o.phone)],
      },
      custom_data: {
        currency: 'MNT', value: o.total, order_id: o.number, content_type: 'product', num_items: o.lines.reduce((a, l) => a + l.qty, 0),
        contents: o.lines.map((l) => ({ id: l.code, quantity: l.qty, item_price: l.unitPrice })),
      },
    }],
    ...(testCode ? { test_event_code: testCode } : {}),
  };
}

/** Хугацаа болсон event-үүдийг илгээнэ (арын ажил). Олон апп зэрэг ажилласан ч SKIP LOCKED-ээр нэг нь л илгээнэ. */
export async function processMetaQueue(limit = 25): Promise<{ sent: number; failed: number }> {
  const cfg = await readConfig();
  if (!cfg.pixelId || !cfg.token) return { sent: 0, failed: 0 };
  let sent = 0; let failed = 0;
  const ids = await db.$queryRaw<{ id: number }[]>`
    UPDATE "MetaEvent" SET "nextAttemptAt" = now() + interval '5 minutes'
    WHERE id IN (SELECT id FROM "MetaEvent" WHERE status IN ('PENDING','FAILED') AND attempts < ${MAX_ATTEMPTS} AND "nextAttemptAt" <= now()
                 ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  for (const { id } of ids) {
    const ev = await db.metaEvent.findUniqueOrThrow({ where: { id } });
    const o = await db.order.findUnique({ where: { id: ev.orderId }, include: { lines: true } });
    if (!o || o.status === 'CANCELLED' || !o.confirmedAt) { await db.metaEvent.update({ where: { id }, data: { status: 'SKIPPED' } }); continue; }
    let err: string | null = null;
    try {
      const res = await fetch(`${GRAPH()}/${encodeURIComponent(cfg.pixelId)}/events`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload(o, cfg.testCode), access_token: cfg.token }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) err = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`;
    } catch (e) { err = (e as Error).message.slice(0, 300); }
    const attempts = ev.attempts + 1;
    if (!err) { sent++; await db.metaEvent.update({ where: { id }, data: { status: 'SENT', attempts, sentAt: new Date(), lastError: null } }); }
    else {
      failed++;
      const wait = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)]!;
      await db.metaEvent.update({ where: { id }, data: { status: 'FAILED', attempts, lastError: err, nextAttemptAt: new Date(Date.now() + wait * 60_000) } });
    }
  }
  return { sent, failed };
}

// ───────────────────────── тохиргоо, лог (админ) ─────────────────────────

export async function getMetaSettings(actor: UserActor) {
  if (!canManageOrderSettings(actor.roles)) throw forbidden();
  const cfg = await readConfig();
  const [counts, recent] = await Promise.all([
    db.metaEvent.groupBy({ by: ['status'], _count: true }),
    db.metaEvent.findMany({ orderBy: { id: 'desc' }, take: 30 }),
  ]);
  const nums = new Map((await db.order.findMany({ where: { id: { in: recent.map((r) => r.orderId) } }, select: { id: true, number: true, total: true } })).map((o) => [o.id, o]));
  return {
    pixelId: cfg.pixelId, tokenSet: !!cfg.token, tokenHint: cfg.token ? `…${cfg.token.slice(-4)}` : null, testCode: cfg.testCode,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    recent: recent.map((r) => ({ id: r.id, orderNumber: nums.get(r.orderId)?.number, total: nums.get(r.orderId)?.total, status: r.status, attempts: r.attempts, lastError: r.lastError, sentAt: r.sentAt, createdAt: r.createdAt })),
  };
}

export async function setMetaSettings(actor: UserActor, input: { pixelId?: unknown; token?: unknown; testCode?: unknown }) {
  if (!canManageOrderSettings(actor.roles)) throw forbidden();
  const upd: [string, string][] = [];
  if (input.pixelId !== undefined) {
    const p = String(input.pixelId ?? '').trim();
    if (p && !/^\d{6,20}$/.test(p)) throw badRequest('Pixel ID зөвхөн тоо (6–20 орон)');
    upd.push([KEYS.pixel, p]);
  }
  if (input.token !== undefined && String(input.token).trim()) {
    const t = String(input.token).trim();
    if (t.length < 20 || t.length > 500 || /\s/.test(t)) throw badRequest('Access Token буруу');
    upd.push([KEYS.token, t]);
  }
  if (input.testCode !== undefined) upd.push([KEYS.test, String(input.testCode ?? '').trim().slice(0, 40)]);
  await db.$transaction(async (tx) => {
    for (const [key, value] of upd) await tx.appSetting.upsert({ where: { key }, create: { key, value, updatedById: actor.id }, update: { value, updatedById: actor.id } });
    // Токен audit-д хэзээ ч бичигдэхгүй
    await writeAudit(actor, 'settings.meta', 'AppSetting', 'meta', { changed: upd.map(([k]) => k) }, tx, ['settings']);
  });
  return getMetaSettings(actor);
}

/** Алдаатай (8 удаа бүтэлгүйтсэн) event-үүдийг дахин оролдох */
export async function retryFailedMeta(actor: UserActor) {
  if (!canManageOrderSettings(actor.roles)) throw forbidden();
  const r = await db.metaEvent.updateMany({ where: { status: 'FAILED' }, data: { attempts: 0, nextAttemptAt: new Date() } });
  if (r.count) await writeAudit(actor, 'meta.retry', 'MetaEvent', null, { requeued: r.count });
  return { requeued: r.count };
}
