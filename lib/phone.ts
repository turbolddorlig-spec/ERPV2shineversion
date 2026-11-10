/** "9911-2233", " 9911 2233 " → "99112233". Монгол дугаар яг 8 оронтой. */
export function normalizePhone(input: string): string {
  return String(input ?? '').replace(/\D/g, '');
}

export function isValidPhone(phone: string): boolean {
  return /^[0-9]{8}$/.test(phone);
}

/** Эзний шийдвэр: утсыг зураасгүй, 8 оронтойгоор (91335599) харуулна */
export function formatPhone(phone: string): string {
  return phone;
}
