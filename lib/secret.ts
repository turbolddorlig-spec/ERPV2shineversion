import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Тохиргооны нууц (Gmail апп нууц үг, Meta токен) — AES-256-GCM. Түлхүүр APP_SECRET-ээс (update.sh / install.sh тогтмол үүсгэнэ). */
const secretKey = () => createHash('sha256').update(`zahialga-gmail|${process.env.APP_SECRET || process.env.DATABASE_URL || ''}`).digest();
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
export function decrypt(s: string): string | null {
  try {
    const [v, iv, tag, data] = s.split(':');
    if (v !== 'v1' || !iv || !tag || !data) return null;
    const d = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}
