/**
 * E12c/d — the gateway under operations, while customers keep browsing.
 *
 *   node load-tests/e12-gateway-ops.mjs down      stop the gateway for 30 s, then start it
 *   node load-tests/e12-gateway-ops.mjs restart   `docker compose restart gateway` (a planned restart)
 *   node load-tests/e12-gateway-ops.mjs reload    change Kong's config twice through its admin API (DB-less /config)
 *   node load-tests/e12-gateway-ops.mjs identity  E14b: stop the identity service for OUTAGE_S (default 60) seconds. Traffic
 *                                                 goes to /cart (every request needs a token check); logins are tried
 *                                                 every 5 s; one order is placed during the outage and its confirmation
 *                                                 email is watched for in Mailpit
 *   node load-tests/e12-gateway-ops.mjs rotate    E14d: a new signing key under traffic (/cart): new key into .env (the old
 *                                                 public key stays accepted), Kong hot-reloaded with both public keys, identity
 *                                                 restarted with the new key, then new logins mixed into the traffic
 *   node load-tests/e12-gateway-ops.mjs recreate  E14d control: recreate the identity container (no key change), same traffic
 *   node load-tests/e12-gateway-ops.mjs jaeger    E13d: stop the tracing backend (Jaeger) for 60 s, then start it; also
 *                                                 records the memory of the traced services before, during and after
 *
 * Traffic: RATE product-page requests per second (default 100) through NGINX → Kong → shop, plus one request per
 * second for the shop's start page (/shop/, served by NGINX itself). Every answer is recorded; the script prints what
 * customers saw in each phase. Plain fetch; 10 seed users share the product-page traffic (per-user limits).
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const BASE = 'http://localhost:8088';
const RATE = Number(process.env.RATE ?? 100);
const mode = process.argv[2];
if (!['down', 'restart', 'reload', 'jaeger', 'identity', 'rotate', 'recreate'].includes(mode)) {
  console.error('usage: node load-tests/e12-gateway-ops.mjs <down|restart|reload|jaeger|identity|rotate|recreate>');
  process.exit(2);
}

const t0 = performance.now();
const at = () => (performance.now() - t0) / 1000;
const log = (...a) => console.log(`${at().toFixed(1).padStart(6)} s  ${new Date().toISOString().slice(11, 23)}`, ...a);
const sh = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'pipe' }).toString().trim();

/** Every answer: [sent at s, status (0 = no answer), ms, what]. */
const answers = [];
let phase = 'before';
const phases = [];
const mark = (name) => {
  phase = name;
  phases.push([name, at()]);
  log(`── ${name}`);
};

// 10 logged-in shoppers share the traffic: anonymous requests would all count against one IP's limit (20/s).
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const tokens = [];
for (let n = 20; n < 30; n++) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `loadtest+${n}@scalecart.local`, password: env.SEED_USER_PASSWORD }),
  });
  const token = (await res.json()).accessToken;
  if (token) tokens.push(token);
}
if (tokens.length < 5) throw new Error(`only ${tokens.length} logins worked`);

let sentCount = 0;
async function one(path, what) {
  const sent = at();
  const p = phase;
  const start = performance.now();
  let status = 0;
  try {
    const headers = what === 'api' ? { authorization: `Bearer ${tokens[sentCount++ % tokens.length]}` } : {};
    const res = await fetch(BASE + path, { headers, signal: AbortSignal.timeout(5_000) });
    await res.arrayBuffer();
    status = res.status;
  } catch {
    status = 0;
  }
  answers.push({ sent, status, ms: performance.now() - start, what, phase: p });
}

let running = true;
async function traffic() {
  const gap = 1000 / RATE;
  let next = performance.now();
  let n = 0;
  while (running) {
    void one(mode === 'identity' || mode === 'rotate' || mode === 'recreate' ? '/cart' : `/products/${1 + Math.floor(Math.random() * 2000)}`, 'api');
    if (++n % RATE === 0) void one('/shop/', 'static');
    next += gap;
    const wait = next - performance.now();
    if (wait > 0) await sleep(wait);
  }
}

function report() {
  console.log('\n| phase | from s | api: requests | api: ok | api: failed (status:count) | api ok p50 / max ms | /shop/ page ok |');
  console.log('|---|---|---|---|---|---|---|');
  for (const [name, from] of phases) {
    const api = answers.filter((a) => a.phase === name && a.what === 'api');
    const ok = api.filter((a) => a.status === 200);
    const bad = api.filter((a) => a.status !== 200);
    const kinds = Object.entries(bad.reduce((m, a) => ((m[a.status] = (m[a.status] ?? 0) + 1), m), {}))
      .map(([s, c]) => `${s}:${c}`)
      .join(' ');
    const ms = ok.map((a) => a.ms).sort((x, y) => x - y);
    const st = answers.filter((a) => a.phase === name && a.what === 'static');
    console.log(
      `| ${name} | ${from.toFixed(1)} | ${api.length} | ${ok.length} | ${bad.length}${kinds ? ` (${kinds})` : ''} | ${ms.length ? `${ms[Math.floor(ms.length / 2)].toFixed(1)} / ${ms.at(-1).toFixed(1)}` : '-'} | ${st.filter((a) => a.status === 200).length} of ${st.length} |`,
    );
  }
  const failed = answers.filter((a) => a.what === 'api' && a.status !== 200).sort((x, y) => x.sent - y.sent);
  if (failed.length) log(`first failure sent at ${failed[0].sent.toFixed(2)} s, last at ${failed.at(-1).sent.toFixed(2)} s`);
}

// A real change: the shop service's read timeout. Applied through the admin API (infra/kong/reload.lua).
const RELOAD = (from, to) =>
  `docker exec scalecart-gateway-1 sh -c "sed 's/read_timeout: ${from}/read_timeout: ${to}/' /tmp/kong.yml > /tmp/kong-new.yml && ` +
  `resty /kong/reload.lua /tmp/kong-new.yml"`;

mark('before');
const flow = traffic();
await sleep(10_000);

if (mode === 'down') {
  mark('gateway stopped');
  const s = performance.now();
  sh('docker compose stop gateway');
  log(`stop took ${((performance.now() - s) / 1000).toFixed(1)} s`);
  await sleep(30_000);
  mark('gateway starting');
  const u = performance.now();
  sh('docker compose start gateway');
  log(`start command returned after ${((performance.now() - u) / 1000).toFixed(1)} s`);
  // First 200 after the start command.
  while (!answers.some((a) => a.phase === 'gateway starting' && a.what === 'api' && a.status === 200)) await sleep(50);
  const first = answers.find((a) => a.phase === 'gateway starting' && a.what === 'api' && a.status === 200);
  log(`first product page served again: request sent ${(first.sent - (u - t0) / 1000).toFixed(2)} s after the start command`);
  await sleep(10_000);
  mark('after');
} else if (mode === 'identity') {
  const OUTAGE_MS = Number(process.env.OUTAGE_S ?? 60) * 1000;
  const loginTries = [];
  const tryLogin = async () => {
    const s = performance.now();
    let status = 0;
    try {
      const res = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'loadtest+31@scalecart.local', password: env.SEED_USER_PASSWORD }),
        signal: AbortSignal.timeout(5_000),
      });
      status = res.status;
    } catch {
      status = 0;
    }
    loginTries.push({ phase, status, ms: performance.now() - s });
  };
  await tryLogin();
  mark('identity stopped');
  const down = performance.now();
  sh('docker compose stop identity');
  log(`identity stopped in ${((performance.now() - down) / 1000).toFixed(1)} s`);

  // An order during the outage: checkout needs no identity; its confirmation email does (the address).
  const buyer = tokens[0];
  const authed = (init = {}) => ({ ...init, headers: { authorization: `Bearer ${buyer}`, 'content-type': 'application/json', ...init.headers } });
  let orderId = '';
  for (let i = 0; i < 5 && !orderId; i++) {
    await fetch(`${BASE}/cart`, { method: 'DELETE', headers: { authorization: `Bearer ${buyer}` } });
    await fetch(`${BASE}/cart/items/${1000 + Math.floor(Math.random() * 150_000)}`, authed({ method: 'PUT', body: JSON.stringify({ quantity: 1 }) }));
    const res = await fetch(`${BASE}/checkout`, authed({ method: 'POST', body: '{}', headers: { 'idempotency-key': crypto.randomUUID() } }));
    if (res.status === 201) orderId = (await res.json()).id;
  }
  const orderedAt = performance.now();
  log(orderId ? `order ${orderId} placed during the outage` : 'could not place an order');

  while (performance.now() - down < OUTAGE_MS) {
    await tryLogin();
    await sleep(5_000);
  }
  mark('identity starting');
  const up = performance.now();
  sh('docker compose start identity');
  log(`start command returned after ${((performance.now() - up) / 1000).toFixed(1)} s`);
  // Logins again: first success after the start command.
  let firstLogin = NaN;
  for (let i = 0; i < 60 && Number.isNaN(firstLogin); i++) {
    await tryLogin();
    if (loginTries.at(-1).status === 200) firstLogin = (performance.now() - up) / 1000;
    else await sleep(500);
  }
  log(`first successful login ${firstLogin.toFixed(1)} s after the start command`);
  mark('after');

  // The confirmation email: delivered late, or given up (dead-letter queue)?
  let mailAfter = NaN;
  for (let i = 0; i < 90 && orderId && Number.isNaN(mailAfter); i++) {
    const found = await (await fetch(`http://localhost:8025/api/v1/search?query=${orderId}`)).json().catch(() => ({}));
    if ((found.messages_count ?? found.total ?? 0) > 0) mailAfter = (performance.now() - orderedAt) / 1000;
    else await sleep(1_000);
  }
  log(Number.isNaN(mailAfter) ? 'confirmation email NOT delivered within 90 s after the outage' : `confirmation email delivered ${mailAfter.toFixed(1)} s after the order`);
  log('dead-letter queue:', sh('docker exec scalecart-rabbitmq-1 rabbitmqctl list_queues name messages --quiet').split(/\r?\n/).filter((l) => /notifications.*dlq/.test(l)).join(' | '));
  const byPhase = Object.groupBy(loginTries, (l) => l.phase);
  for (const [p, tries] of Object.entries(byPhase)) {
    log(`logins in "${p}": ${tries.map((x) => `${x.status}/${Math.round(x.ms)}ms`).join(' ')}`);
  }
} else if (mode === 'recreate') {
  mark('identity recreated');
  const s = performance.now();
  sh(process.env.WITH_DEPS ? 'docker compose up -d --force-recreate identity' : 'docker compose up -d --force-recreate --no-deps identity');
  log(`recreate command returned after ${((performance.now() - s) / 1000).toFixed(1)} s`);
  await sleep(20_000);
  mark('after');
} else if (mode === 'rotate') {
  const readEnv = () =>
    Object.fromEntries(
      readFileSync(resolve(ROOT, '.env'), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  const oldKid = readEnv().IDENTITY_SIGNING_KEY_ID;
  mark('new key + Kong reload');
  log(sh('node infra/identity/new-signing-key.mjs --rotate').split(/\r?\n/)[0]);
  const fresh = readEnv();
  // Kong learns the new public key without a restart: re-render its config inside the container, then hot-load it.
  sh(`docker exec -e IDENTITY_PUBLIC_KEYS=${fresh.IDENTITY_PUBLIC_KEYS} scalecart-gateway-1 sh /kong/render.sh /tmp/kong-rotated.yml`);
  log('Kong admin API:', sh('docker exec scalecart-gateway-1 resty /kong/reload.lua /tmp/kong-rotated.yml'));
  await sleep(Number(process.env.GAP_S ?? 30) * 1000);

  mark('identity restart (new key)');
  const s = performance.now();
  sh('docker compose up -d identity');
  // Logins come back when identity is up; the first token signed with the new key joins the traffic.
  let newToken = '';
  for (let i = 0; i < 120 && !newToken; i++) {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'loadtest+32@scalecart.local', password: env.SEED_USER_PASSWORD }),
    }).catch(() => undefined);
    if (res?.status === 200) newToken = (await res.json()).accessToken;
    else await sleep(250);
  }
  const kid = newToken ? JSON.parse(Buffer.from(newToken.split('.')[0], 'base64url').toString()).kid : '';
  log(`first login after the restart: ${((performance.now() - s) / 1000).toFixed(1)} s, token key id ${kid} (old ${oldKid})`);
  mark('old + new tokens');
  // Half the traffic now uses tokens from the new key (the shop has never seen that kid: it fetches the key set):
  // 5 more users, each in the rotation twice, so every user stays at ~10 req/s (under the per-user limit of 20/s).
  const fresh5 = [newToken];
  for (let n = 33; n <= 36; n++) {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `loadtest+${n}@scalecart.local`, password: env.SEED_USER_PASSWORD }),
    });
    if (res.status === 200) fresh5.push((await res.json()).accessToken);
  }
  if (newToken) for (const tk of fresh5) tokens.push(tk, tk);
  await sleep(20_000);
  mark('after');
} else if (mode === 'jaeger') {
  const memory = () =>
    sh('docker stats --no-stream --format "{{.Name}}={{.MemUsage}}" scalecart-api-4 scalecart-payments-1 scalecart-gateway-1')
      .split(/\r?\n/)
      .map((l) => l.replace('scalecart-', '').replace(/ \/ .*/, ''))
      .join('  ');
  log('memory before:', memory());
  mark('jaeger stopped');
  sh('docker compose stop jaeger');
  await sleep(30_000);
  log('memory after 30 s without Jaeger:', memory());
  await sleep(30_000);
  log('memory after 60 s without Jaeger:', memory());
  mark('jaeger back');
  sh('docker compose start jaeger');
  await sleep(20_000);
  log('memory 20 s after Jaeger is back:', memory());
  mark('after');
} else if (mode === 'restart') {
  mark('restarting');
  const s = performance.now();
  sh('docker compose restart gateway');
  log(`restart command returned after ${((performance.now() - s) / 1000).toFixed(1)} s`);
  await sleep(10_000);
  mark('after');
} else {
  mark('reload 1');
  log('admin API answered', sh(RELOAD('30000', '30001')));
  await sleep(10_000);
  mark('reload 2');
  log('admin API answered', sh(RELOAD('30000', '30000')));
  await sleep(10_000);
  mark('after');
}

await sleep(10_000);
running = false;
await flow;
await sleep(5_500);
report();
