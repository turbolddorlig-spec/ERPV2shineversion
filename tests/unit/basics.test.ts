import { describe, expect, it } from 'vitest';
import { formatPhone, isValidPhone, normalizePhone } from '@/lib/phone';
import bcrypt from 'bcryptjs';
import { generateTempPassword, hashPassword, needsRehash, passwordProblem, verifyPassword } from '@/lib/password';

describe('нууц үгийн hash', () => {
  it('scrypt: зөв/буруу', async () => {
    const h = await hashPassword('Secret123');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('Secret123', h)).toBe(true);
    expect(await verifyPassword('secret123', h)).toBe(false);
    expect(needsRehash(h)).toBe(false);
  });
  it('хуучин системийн bcrypt hash ажиллана, шинэчлэх шаардлагатай', async () => {
    const legacy = bcrypt.hashSync('OldPass1', 10);
    expect(await verifyPassword('OldPass1', legacy)).toBe(true);
    expect(await verifyPassword('wrong', legacy)).toBe(false);
    expect(needsRehash(legacy)).toBe(true);
  });
  it('танихгүй хэлбэр → false', async () => {
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
  });
});

describe('утас', () => {
  it('хэлбэржүүлнэ', () => {
    expect(normalizePhone(' 9911-2233 ')).toBe('99112233');
    expect(normalizePhone('9911 2233')).toBe('99112233');
    expect(formatPhone('99112233')).toBe('9911-2233');
  });
  it('8 оронтой л хүчинтэй', () => {
    expect(isValidPhone('99112233')).toBe(true);
    expect(isValidPhone('9911223')).toBe(false);
    expect(isValidPhone('991122334')).toBe(false);
    expect(isValidPhone('9911223a')).toBe(false);
  });
});

describe('нууц үг', () => {
  it('6-аас богино бол татгалзана', () => {
    expect(passwordProblem('12345')).toMatch(/6/);
    expect(passwordProblem('123456')).toBeNull();
  });
  it('түр нууц үг 8 тэмдэгт, андуурагдах тэмдэгтгүй, давтагдахгүй', () => {
    const set = new Set(Array.from({ length: 500 }, generateTempPassword));
    expect(set.size).toBe(500);
    for (const p of set) expect(p).toMatch(/^[a-hj-km-np-z2-9]{8}$/);
  });
});
