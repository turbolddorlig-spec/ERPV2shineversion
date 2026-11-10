/**
 * ТЕСТИЙН хэрэглэгчид үүсгэнэ (150). Зөвхөн тест/хөгжүүлэлтийн database-д!
 * Хамгаалалт: ALLOW_TEST_SEED=1 байх ёстой. Бодит өгөгдлийг дарж бичихгүй — аль хэдийн байгаа утсыг алгасна.
 */
import { PrismaClient, type Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

if (process.env.ALLOW_TEST_SEED !== '1') {
  console.error('Татгалзлаа: ALLOW_TEST_SEED=1 тохируулаагүй байна (тестийн database-д л ашиглана).');
  process.exit(1);
}

export const TEST_PASSWORD = 'Test1234';
const PLAN: [Role[], number, string][] = [
  [['SUPER_ADMIN'], 1, 'Супер админ'],
  [['ADMIN'], 2, 'Админ'],
  [['OPERATOR_LEAD'], 2, 'Ахлах оператор'],
  [['OPERATOR'], 20, 'Оператор'],
  [['DRIVER_LEAD'], 2, 'Ахлах жолооч'],
  [['DRIVER_LEAD', 'WAREHOUSE'], 1, 'Ахлах жолооч+агуулах'],
  [['DRIVER'], 100, 'Жолооч'],
  [['ACCOUNTING'], 3, 'Нягтлан'],
  [['WAREHOUSE'], 7, 'Агуулах'],
  [['MARKETING_LEAD'], 1, 'Ахлах маркетинг'],
  [['MARKETING'], 6, 'Маркетинг'],
  [['MARKETING', 'WAREHOUSE'], 1, 'Маркетинг+агуулах'],
  [['PENALTY_OFFICER'], 2, 'Торгууль'],
  [['SUPPLIER'], 2, 'Нийлүүлэгч'],
];

async function main() {
  const db = new PrismaClient();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  let n = 0;
  const rows: { phone: string; name: string; roles: Role[]; passwordHash: string }[] = [];
  for (const [roles, count, label] of PLAN) {
    for (let i = 1; i <= count; i++) {
      n++;
      rows.push({ phone: String(80000000 + n), name: `${label} ${i}`, roles, passwordHash });
    }
  }
  const r = await db.user.createMany({ data: rows, skipDuplicates: true });
  console.log(`Тест хэрэглэгч: ${r.count} шинээр үүслээ (нийт төлөвлөсөн ${rows.length}). Нууц үг: ${TEST_PASSWORD}`);
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
