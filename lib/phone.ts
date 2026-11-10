/** "9911-2233", " 9911 2233 " → "99112233". Монгол дугаар яг 8 оронтой. */
export function normalizePhone(input: string): string {
  return String(input ?? '').replace(/\D/g, '');
}

export function isValidPhone(phone: string): boolean {
  return /^[0-9]{8}$/.test(phone);
}

export function formatPhone(phone: string): string {
  return isValidPhone(phone) ? `${phone.slice(0, 4)}-${phone.slice(4)}` : phone;
}
