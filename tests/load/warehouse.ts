/**
 * Агуулахын ачааллын тест (R1): 1,200,000+ хөдөлгөөн, 6 агуулах, 60,000 хувилбартай үед 150 хэрэглэгч зэрэг.
 * Агуулахынхан: үлдэгдэл, өнөөдрийн ажил, дүүргэлт, түүх, хөдөлгөөн + бодит бичилт (орлого, зарлага, шилжүүлэг).
 * Бусад (админ, нягтлан, маркетинг, оператор): үлдэгдэл харах, барааны жагсаалт, зээлийн жагсаалт.
 */
const BASE = process.env.E2E_BASE ?? 'http://localhost:3100';
const USERS = Number(process.env.LOAD_USERS ?? 150);
const ITER = Number(process.env.LOAD_ITER ?? 10);
const THINK = Number(process.env.THINK_MS ?? 0);
const think = () => (THINK > 0 ? new Promise((r) => setTimeout(r, THINK * (0.5 + Math.random()))) : Promise.resolve());
const lat: Record<string, number[]> = {};
let errors = 0; let rejected = 0;
const samples: string[] = [];
const WORDS = ['пүүз', 'цамц', 'Хар', 'кашемир', '0012', 'тос', 'малгай'];

async function hit(kind: string, path: string, cookie: string, body?: unknown) {
  const t0 = performance.now();
  try {
    const r = await fetch(BASE + path, body ? { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' } : { headers: { cookie }, redirect: 'manual' });
    await r.text();
    (lat[kind] ??= []).push(performance.now() - t0);
    // 409 «хүрэлцэхгүй» нь бизнесийн зөв хариу (сөрөг гаргахгүй) — алдаа биш
    if (r.status === 409) rejected++;
    else if (r.status >= 400) { errors++; if (samples.length < 5) samples.push(`${kind} ${r.status}`); }
  } catch (e) { errors++; if (samples.length < 5) samples.push(`${kind} ${(e as Error).message}`); }
}
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };

const STOCKERS = ['80000132', '80000133', '80000134', '80000135', '80000136', '80000137', '80000138', '80000002', '80000003'];
const VIEWERS = ['80000129', '80000130', '80000140', '80000141', '80000006', '80000007', '80000139'];
async function login(phone: string) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password: 'Test1234' }) });
  await r.text();
  return `zs=${/zs=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1]}`;
}
const key = () => `load-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function vu(i: number) {
  if (THINK > 0) await new Promise((r) => setTimeout(r, Math.random() * THINK));
  const stocker = i % 2 === 0;
  const cookie = await login(stocker ? STOCKERS[i % STOCKERS.length]! : VIEWERS[i % VIEWERS.length]!);
  for (let k = 0; k < ITER; k++) {
    const v = 1 + ((i * 977 + k * 131) % 60000);
    if (stocker) {
      await think(); await hit('агуулах хуудас', '/warehouse', cookie);
      await think(); await hit('үлдэгдэл API', `/api/stock?page=${1 + ((i + k) % 400)}&inStock=1`, cookie);
      await think(); await hit('үлдэгдэл хайлт', `/api/stock?q=${encodeURIComponent(WORDS[(i + k) % WORDS.length]!)}&inStock=1`, cookie);
      await think(); await hit('өнөөдрийн ажил', '/api/stock/today', cookie);
      if (k % 2 === 0) { await think(); await hit('дүүргэлт', '/api/stock/refill', cookie); }
      await think(); await hit('барааны түүх', `/api/stock/products/${1 + ((i * 31 + k) % 10000)}/history?page=1&type=all`, cookie);
      await think(); await hit('хөдөлгөөн (агуулахаар)', `/api/stock/moves?warehouseId=${1 + (k % 6)}&page=${1 + (k % 5)}`, cookie);
      // Бодит бичилт: орлого, зарлага (хүрэлцэхгүй бол 409), шилжүүлэг
      await think(); await hit('орлого (бичих)', '/api/stock/receipts', cookie, { warehouseId: 1 + (k % 6), lines: [{ variantId: v, qty: 2 }], idemKey: key() });
      await think(); await hit('зарлага (бичих)', '/api/stock/issues', cookie, { warehouseId: 1, reason: 'SAMPLE', note: 'Ачааллын тест', lines: [{ variantId: v, qty: 1 }], idemKey: key() });
      if (k % 3 === 0) { await think(); await hit('шилжүүлэг (бичих)', '/api/stock/transfers', cookie, { fromWarehouseId: 2 + (k % 5), toWarehouseId: 1, lines: [{ variantId: v, qty: 1 }], idemKey: key() }); }
    } else {
      // Эрхийн дагуу: нягтлан — үлдэгдэл (харах); маркетинг — барааны жагсаалт (үлдэгдэлтэй); оператор — бараа хайх. Бүгд — зээл.
      const ph = VIEWERS[i % VIEWERS.length]!;
      if (ph === '80000129' || ph === '80000130') { await think(); await hit('үлдэгдэл API', `/api/stock?page=${1 + ((i * 3 + k) % 400)}`, cookie); }
      else if (ph === '80000006' || ph === '80000007') { await think(); await hit('бараа хайх (оператор)', `/api/products/search?q=${encodeURIComponent(WORDS[(i + k) % WORDS.length]!)}`, cookie); }
      else { await think(); await hit('барааны жагсаалт (үлдэгдэлтэй)', `/api/products?page=${1 + ((i * 7 + k) % 200)}`, cookie); }
      await think(); await hit('зээлийн жагсаалт', '/api/loans', cookie);
    }
  }
}

(async () => {
  const t0 = performance.now();
  await Promise.all(Array.from({ length: USERS }, (_, i) => vu(i)));
  const secs = (performance.now() - t0) / 1000;
  const total = Object.values(lat).reduce((n, a) => n + a.length, 0);
  console.log(`\nАгуулахын ачаалал (${THINK > 0 ? `хүний хурд ~${THINK}мс` : 'завсаргүй стресс'}): ${USERS} хэрэглэгч — ${total} хүсэлт, ${secs.toFixed(1)} сек (${(total / secs).toFixed(0)}/сек)`);
  console.log('Төрөл                          тоо     p50     p95     p99   (мс)');
  for (const [k, a] of Object.entries(lat)) console.log(`${k.padEnd(28)} ${String(a.length).padStart(5)} ${pct(a, 50).toFixed(0).padStart(7)} ${pct(a, 95).toFixed(0).padStart(7)} ${pct(a, 99).toFixed(0).padStart(7)}`);
  console.log(`Алдаа: ${errors}${samples.length ? ' — ' + samples.join('; ') : ''} · «Хүрэлцэхгүй» (зөв татгалзсан): ${rejected}`);
  if (errors) process.exit(1);
})();
export {};
