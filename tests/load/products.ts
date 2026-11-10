/**
 * Барааны ачааллын тест (R1): 10,000 бараа / 60,000 хувилбартай үед 150 хэрэглэгч зэрэг
 * жагсаалт, хайлт, барааны хуудас, засварын түүхийг ачаална. Оператор захиалга авахад бараа хайна.
 */
const BASE = process.env.E2E_BASE ?? 'http://localhost:3100';
const USERS = Number(process.env.LOAD_USERS ?? 150);
const ITER = Number(process.env.LOAD_ITER ?? 15);
const THINK = Number(process.env.THINK_MS ?? 0);
const think = () => (THINK > 0 ? new Promise((r) => setTimeout(r, THINK * (0.5 + Math.random()))) : Promise.resolve());
const lat: Record<string, number[]> = {};
let errors = 0;
const samples: string[] = [];
const WORDS = ['пүүз', 'цамц', 'Хар', 'кашемир', '0012', '00777', 'тос', 'малгай', 'цүнх', 'гутал'];

async function hit(kind: string, path: string, cookie: string) {
  const t0 = performance.now();
  try {
    const r = await fetch(BASE + path, { headers: { cookie }, redirect: 'manual' });
    await r.text();
    (lat[kind] ??= []).push(performance.now() - t0);
    if (r.status >= 400) { errors++; if (samples.length < 5) samples.push(`${kind} ${r.status}`); }
  } catch (e) { errors++; if (samples.length < 5) samples.push(`${kind} ${(e as Error).message}`); }
}
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };

// Бараа үзэх эрхтэй (Админ, Агуулах, Маркетинг) ба зөвхөн хайдаг (Оператор)
const VIEWERS = ['80000002', '80000003', '80000132', '80000133', '80000134', '80000139', '80000140', '80000141', '80000142', '80000143'];
const OPERATORS = Array.from({ length: 20 }, (_, i) => String(80000006 + i));

async function login(phone: string) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password: 'Test1234' }) });
  await r.text();
  return `zs=${/zs=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1]}`;
}

async function vu(i: number) {
  if (THINK > 0) await new Promise((r) => setTimeout(r, Math.random() * THINK));
  const isOperator = i % 3 === 0;
  const cookie = await login(isOperator ? OPERATORS[i % OPERATORS.length]! : VIEWERS[i % VIEWERS.length]!);
  for (let k = 0; k < ITER; k++) {
    const w = WORDS[(i + k) % WORDS.length]!;
    if (isOperator) {
      await think(); await hit('хайлт (оператор)', `/api/products/search?q=${encodeURIComponent(w)}`, cookie);
      continue;
    }
    await think(); await hit('жагсаалт API', `/api/products?page=${1 + ((i * 7 + k) % 200)}`, cookie);
    await think(); await hit('жагсаалт + хайлт', `/api/products?q=${encodeURIComponent(w)}`, cookie);
    await think(); await hit('барааны хуудас', `/products/${1 + ((i * 131 + k * 17) % 10000)}`, cookie);
    if (k % 3 === 0) { await think(); await hit('засварын түүх', '/api/products/history?page=1', cookie); }
  }
}

(async () => {
  const t0 = performance.now();
  await Promise.all(Array.from({ length: USERS }, (_, i) => vu(i)));
  const secs = (performance.now() - t0) / 1000;
  const total = Object.values(lat).reduce((n, a) => n + a.length, 0);
  console.log(`\nБарааны ачаалал (${THINK > 0 ? `хүний хурд ~${THINK}мс` : 'завсаргүй стресс'}): ${USERS} хэрэглэгч — ${total} хүсэлт, ${secs.toFixed(1)} сек (${(total / secs).toFixed(0)}/сек)`);
  console.log('Төрөл                    тоо     p50     p95     p99   (мс)');
  for (const [k, a] of Object.entries(lat)) console.log(`${k.padEnd(22)} ${String(a.length).padStart(5)} ${pct(a, 50).toFixed(0).padStart(7)} ${pct(a, 95).toFixed(0).padStart(7)} ${pct(a, 99).toFixed(0).padStart(7)}`);
  console.log(`Алдаа: ${errors}${samples.length ? ' — ' + samples.join('; ') : ''}`);
  if (errors) process.exit(1);
})();
export {};
