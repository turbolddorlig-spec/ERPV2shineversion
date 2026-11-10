import bcrypt from 'bcryptjs';
import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

/**
 * Нууц үгийг Node-ийн scrypt-ээр hash хийнэ. scrypt нь тусдаа thread-д ажилладаг тул
 * олон хүн зэрэг нэвтрэхэд сервер гацахгүй (bcryptjs үндсэн урсгалыг хаадаг байсан).
 * Хэлбэр: scrypt$N$r$p$<salt base64>$<hash base64>
 * Хуучин системээс шилжих bcrypt ($2...) hash-ийг шалгаж чадна, нэвтрэхэд шинэ хэлбэрт шилжүүлнэ.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

function scrypt(pw: string, salt: Buffer, keylen: number, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(pw, salt, keylen, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export const PASSWORD_MIN = 6;

export function passwordProblem(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return `Нууц үг дор хаяж ${PASSWORD_MIN} тэмдэгт байх ёстой`;
  if (pw.length > 72) return 'Нууц үг 72 тэмдэгтээс урт байж болохгүй';
  return null;
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 6) return false;
    const expected = Buffer.from(parts[5]!, 'base64');
    const key = await scrypt(pw, Buffer.from(parts[4]!, 'base64'), expected.length, Number(parts[1]), Number(parts[2]), Number(parts[3]));
    return key.length === expected.length && timingSafeEqual(key, expected);
  }
  if (stored.startsWith('$2')) return bcrypt.compare(pw, stored); // хуучин системийн hash
  return false;
}

/** Хуучин (bcrypt) hash бол нэвтрэх үед шинэ хэлбэрт шилжүүлэх хэрэгтэй */
export function needsRehash(stored: string): boolean {
  return !stored.startsWith(['scrypt', N, R, P, ''].join('$'));
}

/** Бичихэд амар түр нууц үг: андуурагдах тэмдэгтгүй (0/O, 1/l/I) 8 тэмдэгт */
export function generateTempPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

/** Байхгүй хэрэглэгчээр оролдоход хариу өгөх хугацааг тэнцүүлнэ (утас таахаас сэргийлнэ) */
let dummyHash: Promise<string> | null = null;
export async function dummyVerify(pw: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(pw, await dummyHash);
}
