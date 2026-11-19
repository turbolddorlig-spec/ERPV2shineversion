import { randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '../../db';
import { badRequest, forbidden } from '../../errors';
import { writeAudit, type Actor } from '../../audit';
import { decrypt, encrypt } from '../../secret';
import type { UserActor } from '../orders/core';
import { accountAllowed, importTransactions, parseKhanMessages } from './bank';

/**
 * #181 Банкны орлого УТАСНААС ШУУД (MacroDroid «HTTP Request») — Gmail-тэй ЯГ ИЖИЛ логик:
 *   зөвхөн «Khan Bank … ORLOGO» мессеж; зарлага, нууц код, мэдээлэл → алгасна; утас + дүнгээр шууд «Мөнгө орсон».
 *   Нэг гүйлгээ Gmail ба утаснаас хоёуланд ирсэн ч нэг л удаа (данс + дүн + үлдэгдэл = fingerprint).
 * Тохиргоо (зөвхөн Супер админ): дансны сүүлийн 4 орон (хоосон = бүх данс; Gmail-д ч үйлчилнэ), нууц түлхүүр (солих боломжтой).
 */
const KEY = 'bank.incoming';
interface S { keyEnc: string | null; accounts: string[]; lastAt: string | null; count: number; lastResult: string | null; rejected: number; lastRejectedAt: string | null }
const DEF: S = { keyEnc: null, accounts: [], lastAt: null, count: 0, lastResult: null, rejected: 0, lastRejectedAt: null };
const SMS_ACTOR: Actor = { id: null, name: 'Утаснаас (MacroDroid)' };

async function read(): Promise<S> {
  const r = await db.appSetting.findUnique({ where: { key: KEY } });
  return { ...DEF, ...((r?.value as Partial<S> | null) ?? {}) };
}
async function write(v: S) { await db.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: v as never }, update: { value: v as never } }); }
async function patch(p: Partial<S>) { await write({ ...(await read()), ...p }); }
const assertSA = (a: UserActor) => { if (!a.roles.includes('SUPER_ADMIN')) throw forbidden('Зөвхөн Супер админ'); };

/** Gmail sync ч энэ жагсаалтаар шүүнэ */
export async function bankAccounts(): Promise<string[]> { return (await read()).accounts; }

export async function getIncomingSettings(actor: UserActor, origin: string) {
  assertSA(actor);
  const s = await read();
  const key = s.keyEnc ? decrypt(s.keyEnc) : null;
  return { accounts: s.accounts, url: key ? `${origin.replace(/\/$/, '')}/api/bank/sms?key=${key}` : null, lastAt: s.lastAt, count: s.count, lastResult: s.lastResult, rejected: s.rejected, lastRejectedAt: s.lastRejectedAt };
}

export async function setAccounts(actor: UserActor, input: unknown) {
  assertSA(actor);
  const raw = Array.isArray(input) ? input.map(String) : String(input ?? '').split(/[\s,;]+/);
  const list = [...new Set(raw.map((x) => x.trim()).filter(Boolean))];
  if (list.some((x) => !/^\d{4}$/.test(x))) throw badRequest('Дансны сүүлийн 4 оронг тоогоор бичнэ (жишээ: 4242). Олон бол таслалаар: 4242, 8385', 'bad_account');
  if (list.length > 10) throw badRequest('10 хүртэл данс', 'bad_account');
  const s = await read();
  await write({ ...s, accounts: list });
  await writeAudit(actor, 'settings.bank_accounts', 'AppSetting', KEY, { from: s.accounts, to: list }, db, ['settings', 'bank', 'money']);
  return list;
}

/** Шинэ түлхүүр — хуучин хаяг шууд хүчингүй (утас алдагдвал) */
export async function rotateKey(actor: UserActor) {
  assertSA(actor);
  const key = randomBytes(24).toString('base64url');
  const s = await read();
  await write({ ...s, keyEnc: encrypt(key) });
  await writeAudit(actor, s.keyEnc ? 'settings.bank_sms_key_rotated' : 'settings.bank_sms_key_created', 'AppSetting', KEY, {}, db, ['settings', 'bank', 'security']);
}
export async function disableSms(actor: UserActor) {
  assertSA(actor);
  await patch({ keyEnc: null });
  await writeAudit(actor, 'settings.bank_sms_disabled', 'AppSetting', KEY, {}, db, ['settings', 'bank', 'security']);
}

// Энгийн хязгаар: минутад 60 хүсэлт (утаснаас хэвийн урсгал хэд хэд л)
let win = { at: 0, n: 0 };
function rateOk() { const now = Date.now(); if (now - win.at > 60_000) win = { at: now, n: 0 }; return ++win.n <= 60; }

function keyOk(given: string, s: S): boolean {
  const k = s.keyEnc ? decrypt(s.keyEnc) : null;
  if (!k || !given) return false;
  const a = Buffer.from(given); const b = Buffer.from(k);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** MacroDroid-оос: түлхүүр + мессежийн текст. Хариу — утасны апп-д харагдах товч мэдээлэл */
export async function receiveSms(keyIn: string, textIn: string): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!rateOk()) return { status: 429, body: { ok: false, error: 'Хэт олон хүсэлт' } };
  const s = await read();
  if (!keyOk(keyIn, s)) {
    await patch({ rejected: s.rejected + 1, lastRejectedAt: new Date().toISOString() });
    if (s.rejected % 20 === 0) await writeAudit({ id: null, name: 'СИСТЕМ' }, 'bank.sms_rejected', 'AppSetting', KEY, { reason: 'буруу түлхүүр' }, db, ['bank', 'security']);
    return { status: 401, body: { ok: false, error: 'Түлхүүр буруу' } };
  }
  const text = String(textIn ?? '').slice(0, 2000);
  const done = async (result: string, extra: Record<string, unknown> = {}) => {
    await patch({ lastAt: new Date().toISOString(), count: s.count + 1, lastResult: result });
    return { status: 200, body: { ok: true, result, ...extra } };
  };
  const p = parseKhanMessages(text, new Date())[0];
  if (!p) return done('Банкны гүйлгээ биш — алгаслаа');
  if (!p.income) return done('Зарлага — алгаслаа');
  if (!accountAllowed(p, s.accounts)) return done(`Өөр данс (${p.account ?? '?'}) — алгаслаа`);
  const r = await importTransactions(SMS_ACTOR, [{ date: p.date, description: p.description, amount: p.amount, phone: p.phone, fingerprint: p.fingerprint }], 'SMS');
  const result = r.duplicates ? `Өмнө орсон (${p.amount}₮)` : r.matched ? `Орлого ${p.amount}₮ — захиалга «Мөнгө орсон»` : r.partial ? `Орлого ${p.amount}₮ — хэсэгчлэн таарсан` : r.imported ? `Орлого ${p.amount}₮ — таараагүй (Банкны импортод)` : `Алдаа: ${r.errors[0] ?? '?'}`;
  return done(result, { imported: r.imported, matched: r.matched });
}
