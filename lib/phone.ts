/** "9911-2233", " 9911 2233 " → "99112233". Монгол дугаар яг 8 оронтой. */
export function normalizePhone(input: string): string {
  const d = String(input ?? '').replace(/\D/g, '');
  // Аудит А11: «+976 8877 6655» / «97688776655» наахад улсын кодыг хасна (#50 3)
  return d.length === 11 && d.startsWith('976') ? d.slice(3) : d;
}

export function isValidPhone(phone: string): boolean {
  return /^[0-9]{8}$/.test(phone);
}

/** Эзний шийдвэр: утсыг зураасгүй, 8 оронтойгоор (91335599) харуулна */
export function formatPhone(phone: string): string {
  return phone;
}
