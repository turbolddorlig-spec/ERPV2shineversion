import type { Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, forbidden } from '../../errors';
import { SYSTEM_ACTOR, writeAudit } from '../../audit';
import type { UserActor } from '../users';
import { decrypt, encrypt } from '../../secret';

/**
 * #166 «Төлбөр хүлээж буй» захиалгын SMS (эзний шийдвэр 2026-11-17).
 * - Захиалга «Төлбөр хүлээж буй» болж ҮҮСЭХЭД нэг л удаа (SmsMessage.orderId давтагдашгүй). Засах, буцаахад илгээхгүй.
 * - Текстийг Супер админ Тохиргоонд бичнэ; {дугаар} {бараа} {дүн} {утас} {банк} {данс} {эзэмшигч}-ийг систем бөглөнө.
 *   Автомат утгууд (бараа, нэр…) Латин болж хөрвөнө — 1 SMS (160) -д багтаана; урт бол барааны жагсаалтыг богиносгоно.
 * - SMS үйлчилгээ солигдох боломжтой: хаяг (https) + JSON биеийн загвар ({key} {token} {phone} {message}).
 * - Түлхүүр, токен шифрлэгдэж хадгалагдана, хариунд хэзээ ч гарахгүй (сүүлийн 4 тэмдэгт л).
 * - Туршилтын горим: бүх SMS зөвхөн туршилтын утас руу.
 * - Захиалгын төлөв, мөнгө, үлдэгдэлд НӨЛӨӨЛӨХГҮЙ; алдаа нь захиалга үүсгэхэд саад болохгүй (дараалал, дахин оролдлого).
 */
const KEY = 'smsConfig';
const BACKOFF_MIN = [1, 5, 15, 60, 360];
const MAX_ATTEMPTS = 6;

export const SMS_DEFAULT_URL = 'https://api.sendsms.mn/api/user/send';
export const SMS_DEFAULT_BODY = '{"apiKey":"{key}","apiToken":"{token}","phone":"{phone}","message":"{message}"}';
export const SMS_DEFAULT_TEMPLATE = 'Sain baina uu. Zahialga #{дугаар}: {бараа} = {дүн}T. {банк} {данс} {эзэмшигч}. Guilgeenii utga: {утас}';
export const SMS_VARS = ['{дугаар}', '{бараа}', '{дүн}', '{утас}', '{банк}', '{данс}', '{эзэмшигч}'] as const;

interface Stored {
  enabled?: boolean; testMode?: boolean; testPhone?: string; template?: string;
  bank?: string; account?: string; holder?: string;
  url?: string; body?: string; key?: string; token?: string;
}
export interface SmsConfig {
  enabled: boolean; testMode: boolean; testPhone: string; template: string;
  bank: string; account: string; holder: string; url: string; body: string; key: string; token: string;
}

async function readStored(tx: Prisma.TransactionClient | typeof db = db): Promise<Stored> {
  const row = await tx.appSetting.findUnique({ where: { key: KEY } });
  return row && typeof row.value === 'object' && row.value ? (row.value as Stored) : {};
}
const dec = (v?: string) => (v ? (v.startsWith('v1:') ? decrypt(v) ?? '' : v) : '');
export async function readSmsConfig(tx: Prisma.TransactionClient | typeof db = db): Promise<SmsConfig> {
  const s = await readStored(tx);
  return {
    enabled: !!s.enabled, testMode: s.testMode !== false, testPhone: s.testPhone ?? '', template: s.template || SMS_DEFAULT_TEMPLATE,
    bank: s.bank ?? '', account: s.account ?? '', holder: s.holder ?? '',
    url: s.url || SMS_DEFAULT_URL, body: s.body || SMS_DEFAULT_BODY, key: dec(s.key), token: dec(s.token),
  };
}

// ───────────────────────── текст ─────────────────────────

const TR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'ye', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', ө: 'u',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ү: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: 'i', э: 'e', ю: 'yu', я: 'ya',
};
/** Монгол кирилл → Латин (SMS 160 тэмдэгтэд багтахын тулд). Бусад GSM бус тэмдэгтийг хасна. */
export function toLatin(s: string): string {
  let out = '';
  for (const ch of s) {
    const low = ch.toLowerCase();
    const t = TR[low];
    if (t !== undefined) out += ch !== low && t ? t[0]!.toUpperCase() + t.slice(1) : t;
    else out += ch;
  }
  // GSM-7-д байхгүй тэмдэгт (emoji, «», — г.м.) → энгийн
  return out.replace(/[«»“”„]/g, '"').replace(/[‘’]/g, "'").replace(/[—–]/g, '-').replace(/₮/g, 'T').replace(/[^\x20-\x7E\n]/g, '').replace(/\s+/g, ' ').trim();
}
const isLatin = (s: string) => /^[\x20-\x7E\n]*$/.test(s);
/** Нэг SMS-ийн дээд урт: Латин 160, кирилл (UCS-2) 70 */
export const smsLimit = (s: string) => (isLatin(s) ? 160 : 70);
const money = (n: number) => n.toLocaleString('en-US');

export interface SmsOrder { number: number | bigint | string; phone: string; total: number; lines: { name: string; label?: string | null; qty: number }[] }

/** Загвараас бодит текст үүсгэнэ. Урт бол барааны жагсаалтыг богиносгож, эцэст нь 1 SMS-д таслана. */
export function renderSms(template: string, cfg: Pick<SmsConfig, 'bank' | 'account' | 'holder'>, o: SmsOrder): { text: string; length: number; limit: number; cut: boolean } {
  const fill = (goods: string) => template
    .replace(/\{дугаар\}/g, String(o.number))
    .replace(/\{дүн\}/g, money(o.total))
    .replace(/\{утас\}/g, o.phone)
    .replace(/\{банк\}/g, toLatin(cfg.bank))
    .replace(/\{данс\}/g, toLatin(cfg.account))
    .replace(/\{эзэмшигч\}/g, toLatin(cfg.holder))
    .replace(/\{бараа\}/g, goods)
    .replace(/\s+/g, ' ').trim();
  const items = o.lines.map((l) => `${toLatin(l.name)}${l.qty > 1 ? ` x${l.qty}` : ''}`);
  let goods = items.join(', ');
  let text = fill(goods);
  const limit = smsLimit(text);
  let cut = false;
  if (text.length > limit && template.includes('{бараа}')) {
    // Барааны хэсгийг багтах хэмжээнд богиносгоно
    const room = Math.max(8, limit - fill('').length);
    if (items.length > 1) goods = `${items[0]} +${items.length - 1} baraa`;
    if (goods.length > room) goods = goods.slice(0, Math.max(5, room - 3)).trimEnd() + '...';
    text = fill(goods);
    cut = true;
  }
  if (text.length > limit) { text = text.slice(0, limit); cut = true; }
  return { text, length: text.length, limit, cut };
}

// ───────────────────────── дараалал ─────────────────────────

/** createOrder-ийн гүйлгээнд: SMS асаалттай бол дараалалд оруулна (унтраалттай бол юу ч бичихгүй) */
export async function enqueueOrderSms(tx: Prisma.TransactionClient, order: { id: number; number: number | bigint | string; phone: string; total: number }, lines: { name: string; label?: string | null; qty: number }[]): Promise<boolean> {
  const cfg = await readSmsConfig(tx);
  if (!cfg.enabled || !cfg.key) return false;
  const to = cfg.testMode ? cfg.testPhone : order.phone;
  if (!/^\d{8}$/.test(to)) return false;
  const { text } = renderSms(cfg.template, cfg, { number: order.number, phone: order.phone, total: order.total, lines });
  await tx.smsMessage.createMany({ data: [{ orderId: order.id, phone: to, text, test: cfg.testMode }], skipDuplicates: true });
  return true;
}

/** JSON биеийн загварт утга оруулна (JSON-д аюулгүй escape) */
function buildBody(tpl: string, v: { key: string; token: string; phone: string; message: string }): string {
  const esc = (s: string) => JSON.stringify(s).slice(1, -1);
  return tpl.replace(/\{key\}/g, esc(v.key)).replace(/\{token\}/g, esc(v.token)).replace(/\{phone\}/g, esc(v.phone)).replace(/\{message\}/g, esc(v.message));
}

/** Үйлчилгээ рүү нэг SMS илгээнэ. Амжилт: HTTP 2xx ба хариуны status 0/false биш. */
async function deliver(cfg: SmsConfig, phone: string, message: string): Promise<{ ok: boolean; info: string }> {
  try {
    const res = await fetch(cfg.url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: buildBody(cfg.body, { key: cfg.key, token: cfg.token, phone, message }), signal: AbortSignal.timeout(10_000),
    });
    const txt = (await res.text().catch(() => '')).slice(0, 500);
    let parsed: { status?: unknown; message?: unknown } | null = null;
    try { parsed = JSON.parse(txt); } catch { /* JSON биш хариу */ }
    const bad = !res.ok || (parsed && (parsed.status === 0 || parsed.status === false || parsed.status === '0'));
    const msg = parsed && typeof parsed.message === 'string' ? parsed.message : txt;
    return { ok: !bad, info: bad ? `HTTP ${res.status}: ${msg}`.slice(0, 300) : msg.slice(0, 300) };
  } catch (e) {
    return { ok: false, info: (e as Error).message.slice(0, 300) };
  }
}

/** Хугацаа болсон SMS-үүдийг илгээнэ (захиалга үүссэний дараа шууд + арын ажил минут тутам). SKIP LOCKED — нэг л удаа. */
export async function processSmsQueue(limit = 25): Promise<{ sent: number; failed: number }> {
  const cfg = await readSmsConfig();
  if (!cfg.enabled || !cfg.key) return { sent: 0, failed: 0 };
  let sent = 0; let failed = 0;
  const ids = await db.$queryRaw<{ id: number }[]>`
    UPDATE "SmsMessage" SET "nextAttemptAt" = now() + interval '5 minutes'
    WHERE id IN (SELECT id FROM "SmsMessage" WHERE status IN ('PENDING','FAILED') AND attempts < ${MAX_ATTEMPTS} AND "nextAttemptAt" <= now()
                 ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  for (const { id } of ids) {
    const m = await db.smsMessage.findUniqueOrThrow({ where: { id } });
    const o = await db.order.findUnique({ where: { id: m.orderId }, select: { id: true, number: true, status: true } });
    // Илгээхээс өмнө мөнгө орсон / цуцлагдсан бол хэрэггүй
    if (!o || o.status !== 'PENDING_PAYMENT') {
      await db.smsMessage.update({ where: { id }, data: { status: 'SKIPPED', lastError: 'Илгээхээс өмнө төлөв өөрчлөгдсөн' } });
      continue;
    }
    const r = await deliver(cfg, m.phone, m.text);
    const attempts = m.attempts + 1;
    if (r.ok) {
      sent++;
      await db.smsMessage.update({ where: { id }, data: { status: 'SENT', attempts, sentAt: new Date(), lastError: null, response: r.info } });
      await writeAudit(SYSTEM_ACTOR, 'order.sms_sent', 'Order', String(o.id), { number: String(o.number), phone: m.phone, test: m.test, text: m.text }, undefined, ['sms']);
    } else {
      failed++;
      const wait = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)]!;
      await db.smsMessage.update({ where: { id }, data: { status: 'FAILED', attempts, lastError: r.info, nextAttemptAt: new Date(Date.now() + wait * 60_000) } });
      if (attempts >= MAX_ATTEMPTS) await writeAudit(SYSTEM_ACTOR, 'order.sms_failed', 'Order', String(o.id), { number: String(o.number), phone: m.phone, error: r.info }, undefined, ['sms']);
    }
  }
  if (sent || failed) failCache = null;
  return { sent, failed };
}

/** Захиалга үүссэний дараа (гүйлгээ дууссаны дараа) — хүлээлгүй шууд илгээнэ; алдаа нь захиалгад нөлөөлөхгүй */
export function kickSms() {
  if (process.env.NODE_ENV === 'test' && !process.env.SMS_KICK_IN_TEST) return;
  void processSmsQueue(5).catch((e) => console.error('[sms]', (e as Error).message));
}

// ───────────────────────── тохиргоо (зөвхөн Супер админ) ─────────────────────────

const isSA = (a: UserActor) => a.roles.includes('SUPER_ADMIN');
const SAMPLE: SmsOrder = { number: 1004006, phone: '88112233', total: 95000, lines: [{ name: 'Хөнгөн куртка', qty: 2 }] };

export async function getSmsSettings(actor: UserActor) {
  if (!isSA(actor)) throw forbidden();
  const cfg = await readSmsConfig();
  const [counts, recent] = await Promise.all([
    db.smsMessage.groupBy({ by: ['status'], _count: true }),
    db.smsMessage.findMany({ orderBy: { id: 'desc' }, take: 20 }),
  ]);
  const nums = new Map((await db.order.findMany({ where: { id: { in: recent.map((r) => r.orderId) } }, select: { id: true, number: true } })).map((o) => [o.id, String(o.number)]));
  const preview = renderSms(cfg.template, cfg, SAMPLE);
  return {
    enabled: cfg.enabled, testMode: cfg.testMode, testPhone: cfg.testPhone, template: cfg.template,
    bank: cfg.bank, account: cfg.account, holder: cfg.holder, url: cfg.url, body: cfg.body,
    keySet: !!cfg.key, keyHint: cfg.key ? `…${cfg.key.slice(-4)}` : null, tokenSet: !!cfg.token, tokenHint: cfg.token ? `…${cfg.token.slice(-4)}` : null,
    defaults: { url: SMS_DEFAULT_URL, body: SMS_DEFAULT_BODY, template: SMS_DEFAULT_TEMPLATE }, vars: SMS_VARS,
    preview, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    recent: recent.map((r) => ({ id: r.id, orderNumber: nums.get(r.orderId) ?? null, phone: r.phone, text: r.text, status: r.status, test: r.test, attempts: r.attempts, lastError: r.lastError, sentAt: r.sentAt, createdAt: r.createdAt })),
  };
}

const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
function checkUrl(u: string) {
  let url: URL;
  try { url = new URL(u); } catch { throw badRequest('SMS илгээх хаяг буруу'); }
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1)/i.test(url.hostname);
  if (url.protocol !== 'https:' || local) throw badRequest('SMS илгээх хаяг https://-ээр эхэлсэн, гадны сайт байх ёстой');
}

export async function setSmsSettings(actor: UserActor, input: Record<string, unknown>) {
  if (!isSA(actor)) throw forbidden('Зөвхөн Супер админ');
  const cur = await readStored();
  const next: Stored = { ...cur };
  const changed: string[] = [];
  const setStr = (k: keyof Stored, v: unknown, max: number) => {
    if (v === undefined) return;
    const s = str(v, max);
    if ((cur[k] ?? '') !== s) { (next as Record<string, unknown>)[k] = s; changed.push(k); }
  };
  if (input.enabled !== undefined && !!input.enabled !== !!cur.enabled) { next.enabled = !!input.enabled; changed.push('enabled'); }
  if (input.testMode !== undefined && !!input.testMode !== (cur.testMode !== false)) { next.testMode = !!input.testMode; changed.push('testMode'); }
  if (input.testPhone !== undefined) {
    const p = str(input.testPhone, 8);
    if (p && !/^\d{8}$/.test(p)) throw badRequest('Туршилтын утас 8 оронтой байна');
    setStr('testPhone', p, 8);
  }
  if (input.template !== undefined) {
    const t = str(input.template, 400);
    if (t.length < 5) throw badRequest('Мессежийн текст хоосон байна');
    setStr('template', t, 400);
  }
  setStr('bank', input.bank, 40); setStr('account', input.account, 40); setStr('holder', input.holder, 60);
  if (input.url !== undefined) { const u = str(input.url, 300); checkUrl(u); setStr('url', u, 300); }
  if (input.body !== undefined) {
    const b = str(input.body, 2000);
    if (!b.includes('{phone}') || !b.includes('{message}')) throw badRequest('Илгээх өгөгдөлд {phone}, {message} заавал байна');
    try { JSON.parse(buildBody(b, { key: 'k', token: 't', phone: '88000000', message: 'm "x"' })); } catch { throw badRequest('Илгээх өгөгдөл JSON хэлбэртэй биш байна'); }
    setStr('body', b, 2000);
  }
  for (const k of ['key', 'token'] as const) {
    const v = input[k];
    if (v !== undefined && String(v).trim()) {
      const s = String(v).trim();
      if (s.length < 6 || s.length > 300 || /\s/.test(s)) throw badRequest(k === 'key' ? 'API түлхүүр буруу' : 'Токен буруу');
      next[k] = encrypt(s); changed.push(k);
    }
  }
  const after = { ...next };
  if (after.enabled && (!dec(after.key) || !(after.account ?? '').trim())) throw badRequest('Асаахын өмнө API түлхүүр, дансны дугаар оруулна уу');
  if (after.enabled && after.testMode !== false && !/^\d{8}$/.test(after.testPhone ?? '')) throw badRequest('Туршилтын горимд туршилтын утас оруулна уу');
  if (!changed.length) return getSmsSettings(actor);
  await db.$transaction(async (tx) => {
    await tx.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: next as Prisma.InputJsonValue, updatedById: actor.id }, update: { value: next as Prisma.InputJsonValue, updatedById: actor.id } });
    // Түлхүүр, токен audit-д хэзээ ч бичигдэхгүй; данс, текст, хаяг өөрчлөлтийг бичнэ (мөнгөний аюулгүй байдал)
    const shown = Object.fromEntries(changed.filter((k) => k !== 'key' && k !== 'token').map((k) => [k, { from: (cur as Record<string, unknown>)[k] ?? null, to: (next as Record<string, unknown>)[k] ?? null }]));
    await writeAudit(actor, 'settings.sms', 'AppSetting', KEY, { changed, ...shown } as Prisma.InputJsonValue, tx, ['settings', 'money']);
  });
  failCache = null;
  return getSmsSettings(actor);
}

/** Урьдчилсан харагдац — хадгалаагүй текстээр */
export async function previewSms(actor: UserActor, input: { template?: unknown; bank?: unknown; account?: unknown; holder?: unknown }) {
  if (!isSA(actor)) throw forbidden();
  const cfg = await readSmsConfig();
  const t = input.template !== undefined ? str(input.template, 400) : cfg.template;
  return renderSms(t, { bank: input.bank !== undefined ? str(input.bank, 40) : cfg.bank, account: input.account !== undefined ? str(input.account, 40) : cfg.account, holder: input.holder !== undefined ? str(input.holder, 60) : cfg.holder }, SAMPLE);
}

/** «Туршиж илгээх» — хадгалсан тохиргоогоор туршилтын утас руу жишээ мессеж (шууд хариу) */
export async function testSms(actor: UserActor) {
  if (!isSA(actor)) throw forbidden();
  const cfg = await readSmsConfig();
  if (!cfg.key) throw badRequest('API түлхүүр оруулаагүй байна');
  if (!/^\d{8}$/.test(cfg.testPhone)) throw badRequest('Туршилтын утас оруулна уу');
  const { text } = renderSms(cfg.template, cfg, SAMPLE);
  const r = await deliver(cfg, cfg.testPhone, text);
  await writeAudit(actor, 'settings.sms_test', 'AppSetting', KEY, { phone: cfg.testPhone, ok: r.ok, info: r.info }, undefined, ['settings']);
  return { ok: r.ok, info: r.info, text };
}

export async function retryFailedSms(actor: UserActor) {
  if (!isSA(actor)) throw forbidden();
  const r = await db.smsMessage.updateMany({ where: { status: 'FAILED' }, data: { attempts: 0, nextAttemptAt: new Date() } });
  if (r.count) { await writeAudit(actor, 'sms.retry', 'SmsMessage', null, { requeued: r.count }); kickSms(); }
  return { requeued: r.count };
}

let failCache: { at: number; v: { count: number; error: string | null } | null } | null = null;
/** Супер админы хонхонд: сүүлийн 24 цагт явж чадаагүй SMS (үлдэгдэл дууссан, түлхүүр буруу г.м.) */
export async function smsFailAlert(): Promise<{ count: number; error: string | null } | null> {
  if (failCache && Date.now() - failCache.at < 60_000) return failCache.v;
  const since = new Date(Date.now() - 86_400_000);
  const [count, last] = await Promise.all([
    db.smsMessage.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
    db.smsMessage.findFirst({ where: { status: 'FAILED', createdAt: { gte: since } }, orderBy: { id: 'desc' }, select: { lastError: true } }),
  ]);
  const v = count ? { count, error: last?.lastError ?? null } : null;
  failCache = { at: Date.now(), v };
  return v;
}
