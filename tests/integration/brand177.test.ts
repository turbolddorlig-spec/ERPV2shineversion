import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** #177 Лого ба нэр — Тохиргоо (зөвхөн Супер админ) */
let db: typeof import('@/lib/db').db;
let B: typeof import('@/lib/services/brand');
let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'brand-'));
  process.env.UPLOAD_DIR = dir;
  db = (await import('@/lib/db')).db;
  B = await import('@/lib/services/brand');
});
let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(76000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
async function err(p: Promise<unknown>, status: number, code?: string) {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AppError); expect((e as AppError).status).toBe(status); if (code) expect((e as AppError).code).toBe(code); return; }
  throw new Error(`Алдаа гарах ёстой байсан (${status})`);
}
let sa: UserActor; let admin: UserActor;
beforeEach(async () => { await resetDb(db as never); sa = await actor(['SUPER_ADMIN']); admin = await actor(['ADMIN']); });

describe('#177 лого ба нэр', () => {
  it('анхдагч: zahialga• ; зөвхөн Супер админ; нэр шалгалт; түүхэнд', async () => {
    expect(B.brandText(await B.getBrand())).toBe('zahialga•');
    await err(B.getBrandSettings(admin), 403);
    await err(B.setBrandName(admin, { name: 'Shine' }), 403);
    await err(B.setBrandName(sa, { name: '' }), 400, 'bad_name');
    await err(B.setBrandName(sa, { name: 'x'.repeat(31) }), 400, 'bad_name');
    await err(B.setBrandName(sa, { name: '<script>' }), 400, 'bad_name');
    await B.setBrandName(sa, { name: '  Shine   Хүргэлт ', dot: false });
    const s = await B.getBrandSettings(sa);
    expect([s.name, s.dot, s.text, s.logo]).toEqual(['Shine Хүргэлт', false, 'Shine Хүргэлт', null]);
    expect((await db.auditLog.findFirstOrThrow({ where: { action: 'settings.brand_name' } })).details).toMatchObject({ from: 'zahialga•', to: 'Shine Хүргэлт' });
  });

  it('лого: зураг → дөрвөлжин PNG 3 хэмжээ, хувилбартай хаяг; буруу файл 400; анхны руу буцаах', async () => {
    const img = await sharp({ create: { width: 900, height: 400, channels: 3, background: '#0F766E' } }).jpeg().toBuffer();
    await err(B.setBrandLogo(admin, img), 403);
    await err(B.setBrandLogo(sa, Buffer.from('<svg onload=alert(1)>')), 400);
    await err(B.setBrandLogo(sa, Buffer.alloc(0)), 400, 'image_empty');
    await B.setBrandLogo(sa, img);
    const s = await B.getBrandSettings(sa);
    expect(s.logo).toMatch(/^\/brand\/logo-512\.png\?v=\d+$/);
    for (const f of ['logo-512.png', 'logo-180.png', 'logo-64.png']) {
      const m = await sharp(await B.readLogoFile(f) as Buffer).metadata();
      expect([m.format, m.width, m.height]).toEqual(['png', Number(f.match(/\d+/)![0]), Number(f.match(/\d+/)![0])]);
    }
    expect(await B.readLogoFile('../../etc/passwd')).toBeNull();
    await B.resetBrand(sa);
    expect(await B.getBrandSettings(sa)).toMatchObject({ name: 'zahialga', dot: true, logo: null });
    await expect(stat(path.join(dir, 'brand'))).rejects.toThrow();
    expect(await db.auditLog.count({ where: { action: { in: ['settings.brand_logo', 'settings.brand_reset'] } } })).toBe(2);
  });
});
