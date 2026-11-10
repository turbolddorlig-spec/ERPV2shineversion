// Анхны Супер админыг үүсгэнэ (install.sh дуудна). Аль хэдийн байвал юу ч хийхгүй.
// Хэрэглээ: ADMIN_PHONE=99112233 ADMIN_NAME="Нэр" ADMIN_PASSWORD="..." node scripts/create-super-admin.mjs
import { PrismaClient } from '@prisma/client';
import { randomBytes, scrypt } from 'node:crypto';

const phone = String(process.env.ADMIN_PHONE ?? '').replace(/\D/g, '');
const name = String(process.env.ADMIN_NAME ?? '').trim();
const password = String(process.env.ADMIN_PASSWORD ?? '');

if (!/^[0-9]{8}$/.test(phone)) { console.error('ADMIN_PHONE 8 оронтой байх ёстой'); process.exit(1); }
if (name.length < 2) { console.error('ADMIN_NAME оруулна уу'); process.exit(1); }
if (password.length < 6) { console.error('ADMIN_PASSWORD дор хаяж 6 тэмдэгт'); process.exit(1); }

// lib/password.ts-тэй яг ижил хэлбэр
function hashPassword(pw) {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(['scrypt', 16384, 8, 1, salt.toString('base64'), key.toString('base64')].join('$'));
    });
  });
}

const db = new PrismaClient();
try {
  const existing = await db.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } });
  if (existing > 0) {
    console.log('Супер админ аль хэдийн бий — алгаслаа.');
  } else {
    const u = await db.user.create({ data: { phone, name, roles: ['SUPER_ADMIN'], passwordHash: await hashPassword(password) } });
    await db.auditLog.create({
      data: { actorId: null, actorName: 'СИСТЕМ (суулгалт)', action: 'user.created', entityType: 'User', entityId: u.id, details: { phone, name, roles: ['SUPER_ADMIN'] } },
    });
    console.log(`Супер админ үүслээ: ${name} (${phone})`);
  }
} finally {
  await db.$disconnect();
}
