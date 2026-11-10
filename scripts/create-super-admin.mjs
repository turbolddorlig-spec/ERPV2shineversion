// Анхны Супер админыг үүсгэнэ (install.sh дуудна). Аль хэдийн байвал юу ч хийхгүй.
// Хэрэглээ: ADMIN_PHONE=99112233 ADMIN_NAME="Нэр" ADMIN_PASSWORD="..." node scripts/create-super-admin.mjs
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const phone = String(process.env.ADMIN_PHONE ?? '').replace(/\D/g, '');
const name = String(process.env.ADMIN_NAME ?? '').trim();
const password = String(process.env.ADMIN_PASSWORD ?? '');

if (!/^[0-9]{8}$/.test(phone)) { console.error('ADMIN_PHONE 8 оронтой байх ёстой'); process.exit(1); }
if (name.length < 2) { console.error('ADMIN_NAME оруулна уу'); process.exit(1); }
if (password.length < 6) { console.error('ADMIN_PASSWORD дор хаяж 6 тэмдэгт'); process.exit(1); }

const db = new PrismaClient();
try {
  const existing = await db.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } });
  if (existing > 0) {
    console.log('Супер админ аль хэдийн бий — алгаслаа.');
  } else {
    const u = await db.user.create({ data: { phone, name, roles: ['SUPER_ADMIN'], passwordHash: await bcrypt.hash(password, 10) } });
    await db.auditLog.create({ data: { actorId: null, actorName: 'СИСТЕМ (суулгалт)', action: 'user.created', entityType: 'User', entityId: u.id, details: { phone, name, roles: ['SUPER_ADMIN'] } } });
    console.log(`Супер админ үүслээ: ${name} (${phone})`);
  }
} finally {
  await db.$disconnect();
}
