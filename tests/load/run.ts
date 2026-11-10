/**
 * Ачааллын тест (R1): 150 хэрэглэгч ЗЭРЭГ нэвтэрч, тус бүр 20 удаа хуудас/API ачаална.
 * Тест database-д seed-test-data.ts-ийн хэрэглэгчид байх ёстой.
 */
const BASE = process.env.E2E_BASE ?? 'http://localhost:3100';
const USERS = Number(process.env.LOAD_USERS ?? 150);
const ITER = Number(process.env.LOAD_ITER ?? 20);
/** Хүний хурд: хүсэлт хооронд THINK_MS ± 50% хүлээнэ (0 = завсаргүй стресс тест) */
const THINK = Number(process.env.THINK_MS ?? 0);
const think = () => (THINK > 0 ? new Promise((r) => setTimeout(r, THINK * (0.5 + Math.random()))) : Promise.resolve());

const lat: Record<string, number[]> = {};
let errors = 0;
const errSamples: string[] = [];

async function timed(kind: string, path: string, init: RequestInit) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + path, { ...init, redirect: 'manual' });
    const body = await res.text();
    (lat[kind] ??= []).push(performance.now() - t0);
    if (res.status >= 400 && res.status !== 403) { errors++; if (errSamples.length < 5) errSamples.push(`${kind} ${res.status}`); }
    return { res, body };
  } catch (e) {
    errors++; if (errSamples.length < 5) errSamples.push(`${kind} ${(e as Error).message}`);
    return null;
  }
}

const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };

async function vu(i: number) {
  if (THINK > 0) await new Promise((r) => setTimeout(r, Math.random() * THINK)); // бүгд яг нэг мөчид биш
  const phone = String(80000000 + 1 + (i % 150));
  const res = await timed('нэвтрэх', '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password: 'Test1234' }) });
  if (!res || res.res.status !== 200) return;
  const m = /zs=([^;]+)/.exec(res.res.headers.get('set-cookie') ?? '');
  const cookie = `zs=${m?.[1]}`;
  const next = (JSON.parse(res.body) as { next?: string }).next ?? '/me';
  for (let k = 0; k < ITER; k++) {
    await think();
    await timed('хуудас (нүүр)', next, { headers: { cookie } });
    await think();
    await timed('хуудас (/me)', '/me', { headers: { cookie } });
    await think();
    await timed('API жагсаалт', `/api/users?page=${1 + (k % 6)}&status=all`, { headers: { cookie } });
  }
}

async function main() {
  const t0 = performance.now();
  await Promise.all(Array.from({ length: USERS }, (_, i) => vu(i)));
  const secs = (performance.now() - t0) / 1000;
  const total = Object.values(lat).reduce((n, a) => n + a.length, 0);
  console.log(`\nАчааллын тест (${THINK > 0 ? `хүний хурд ~${THINK}мс` : 'завсаргүй стресс'}): ${USERS} зэрэг хэрэглэгч × ${ITER} давталт — ${total} хүсэлт, ${secs.toFixed(1)} сек (${(total / secs).toFixed(0)} хүсэлт/сек)`);
  console.log('Төрөл                 тоо     p50     p95     p99   (мс)');
  for (const [k, a] of Object.entries(lat)) {
    console.log(`${k.padEnd(20)} ${String(a.length).padStart(5)} ${pct(a, 50).toFixed(0).padStart(7)} ${pct(a, 95).toFixed(0).padStart(7)} ${pct(a, 99).toFixed(0).padStart(7)}`);
  }
  console.log(`Алдаа: ${errors}${errSamples.length ? ' — ' + errSamples.join('; ') : ''}`);
  if (errors > 0) process.exit(1);
}
main();
