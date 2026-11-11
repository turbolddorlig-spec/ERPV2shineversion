import type { Prisma } from '@prisma/client';
import { db } from '../../db';
import { conflict } from '../../errors';

type Tx = Prisma.TransactionClient;

/**
 * Модуль 6 (#83): тооцооны өдөр = падааны өдөр. Жолооч тооцоогоо илгээсэн (PENDING) эсвэл нягтлан баталгаажуулсан (COMPLETED)
 * өдрийн падааны захиалгын үр дүнг (хүргэсэн / цуцалсан / маргааш) чимээгүй өөрчлөхгүй — тоо зөрөхгүй.
 * Нягтлан (allowPending) хүлээгдэж буй тооцоотой өдөрт засвар хийж болно — баталгаажуулахад дүн дахин шалгагдана.
 */
export async function assertDayOpen(tx: Tx | typeof db, handoverId: number | null | undefined, opts: { allowPending?: boolean } = {}) {
  if (!handoverId) return;
  const h = await tx.handover.findUnique({ where: { id: handoverId }, select: { driverId: true, date: true } });
  if (!h) return;
  // Тооцооны мөрийг түгжинэ (#124-7): баталгаажуулалт ба төлөв өөрчлөх нэг зэрэг явахгүй — нэг нь нөгөөгөө хүлээгээд шинэ дүнгээр
  const rows = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "DriverSettlement" WHERE "driverId" = ${h.driverId}::uuid AND date = ${h.date} FOR UPDATE`;
  const s = rows[0];
  if (!s) return;
  if (s.status === 'COMPLETED') throw conflict('Энэ өдрийн тооцоог нягтлан баталгаажуулсан — өөрчлөх боломжгүй', 'day_locked');
  if (s.status === 'PENDING' && !opts.allowPending) throw conflict('Энэ өдрийн тооцоог илгээсэн байна — эхлээд «Орлого» табаас «Тооцоо буцаах» дарна уу', 'day_submitted');
}
