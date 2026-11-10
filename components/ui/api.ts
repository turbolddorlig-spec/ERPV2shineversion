/** Клиент талын жижиг fetch туслах: алдааны мессежийг монголоор буцаана */
export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { window.location.href = '/login'; throw new Error('Нэвтрэх шаардлагатай'); }
  if (!res.ok) throw new ApiError(data.error ?? 'Алдаа гарлаа', data.code ?? 'error', res.status);
  return data as T;
}

export class ApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
