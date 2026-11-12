/**
 * Аудит #142: «Мөнгө орсон» зөвхөн банкаар — тестэд урьдчилгааг банкны гүйлгээ (утас + дүн) импортлож автоматаар тааруулна.
 */
export async function bankPay(orderId: number, amount?: number) {
  const { db } = await import('@/lib/db');
  const B = await import('@/lib/services/accounting/bank');
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  return B.importTransactions({ id: null, name: 'Тест банк' }, [{ date: new Date(), description: `${o.phone} төлбөр`, amount: amount ?? o.total - o.paidAmount, phone: o.phone }], 'CSV');
}
