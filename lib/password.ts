import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';

export const PASSWORD_MIN = 6;
const COST = 10;

export function passwordProblem(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return `Нууц үг дор хаяж ${PASSWORD_MIN} тэмдэгт байх ёстой`;
  if (pw.length > 72) return 'Нууц үг 72 тэмдэгтээс урт байж болохгүй';
  return null;
}

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, COST);
}

export function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

/** Бичихэд амар түр нууц үг: андуурагдах тэмдэгтгүй (0/O, 1/l/I) 8 тэмдэгт */
export function generateTempPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

/** Байхгүй хэрэглэгчээр оролдоход хариу өгөх хугацааг тэнцүүлнэ (утас таахаас сэргийлнэ) */
let dummyHash: string | null = null;
export async function dummyVerify(pw: string): Promise<void> {
  dummyHash ??= bcrypt.hashSync('dummy-password-for-timing', COST);
  await bcrypt.compare(pw, dummyHash);
}
