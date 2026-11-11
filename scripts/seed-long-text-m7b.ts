/** B3/R3 (Модуль 7б): ажилтны цалингийн урт текстийн ХУУРАМЧ өгөгдөл (dev database) */
import { db } from '../lib/db';
import { ubDay } from '../lib/ubdate';
import * as S from '../lib/services/salary';
(async () => {
  const act = async (phone: string) => { const u = await db.user.findFirstOrThrow({ where: { phone } }); return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' }; };
  const sa = await act('80000001'); const op = await act('80000006');
  const LONG = 'Зайгүймаашуртүгбайнаадрестэндэхтэйбайраатооттойгуддаар'.repeat(2);
  const key = `u:${op.id}`; const ym = ubDay().slice(0, 7);
  await S.setConfig(sa, { staffKey: key, salaryType: 'FIXED', baseSalary: 1_800_000, bonusSalary: 150_000, bankName: `Урт нэртэй банк ${LONG}`.slice(0, 60), bankAccount: '5000123456789' });
  await S.addDebt(sa, { staffKey: key, description: `Урт өр: урьдчилгаа, утас, гэр бүлийн тусламж ${LONG}`, amount: 500_000 }).catch(() => null);
  await S.addExternal(sa, { name: `Урт нэртэй гадны ажилтан ${LONG}`.slice(0, 80), jobTitle: `Цэвэрлэгч ба харуул ${LONG}`.slice(0, 80), baseSalary: 900_000 }).catch(() => null);
  await S.setWorkDay(sa, { staffKey: key, date: `${ym}-02`, dayType: 'SICK', note: 'Өвчтэй' }).catch(() => null);
  await S.saveSalary(sa, { staffKey: key, ym, half: 1, additions: [{ label: `Илүү цаг ${LONG}`, amount: 75_000 }], deductions: [{ label: `Хоцролт ${LONG}`, amount: 30_000 }], notes: `Урт тэмдэглэл ${LONG}` }).catch((e) => console.log(String(e).slice(0, 100)));
  console.log('ok'); await db.$disconnect();
})();
