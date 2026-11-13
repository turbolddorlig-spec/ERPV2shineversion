/**
 * Аудит #142: «Мөнгө орсон» зөвхөн банкаар — тестэд урьдчилгааг банкны гүйлгээ (утас + дүн) импортлож автоматаар тааруулна.
 */
export async function bankPay(orderId: number, amount?: number) {
  const { db } = await import('@/lib/db');
  const B = await import('@/lib/services/accounting/bank');
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  // Аудит #148: зөвхөн Gmail (имэйл бүр өөрийн дугаартай)
  return B.importTransactions({ id: null, name: 'Тест банк' }, [{ date: new Date(), description: `${o.phone} төлбөр`, amount: amount ?? o.total - o.paidAmount, phone: o.phone, emailMessageId: `test-${orderId}-${Date.now()}-${Math.random().toString(36).slice(2)}` }], 'GMAIL');
}
