/**
 * E10 — Two-factor login (TOTP), measured through NGINX against the running stack.
 *
 *   a) clock: the API's clock vs this machine's, sampled every 2 s (TOTP codes depend on it)
 *   b) cost: password step vs code step, for users with 2FA (and a plain login for comparison)
 *   c) guessing: wrong codes one by one, then 30 at once, for a fresh 2FA user
 *
 * Needs RATE_LIMIT_AUTH roomy on the API (it registers and logs in many users from one IP).
 *   node scripts/e10-two-factor.ts [baseUrl] [clockSeconds] [users]
 */
import { createHmac, randomUUID } from 'node:crypto';

const BASE = process.argv[2] ?? 'http://localhost:8088';
const CLOCK_SECONDS = Number(process.argv[3] ?? 180);
const USERS = Number(process.argv[4] ?? 30);
/** Any existing drop: GET /drops/:id answers with the server's time in ms. */
const DROP_ID = Number(process.argv[5] ?? 35);

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of text) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
/** The authenticator app: HOTP(secret, 30 s step), using THIS machine's clock (like a phone would). */
function code(secret: string, stepsAhead = 0): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + stepsAhead));
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const n = mac.readUInt32BE(mac[mac.length - 1] & 0x0f) & 0x7fffffff;
  return String(n % 1_000_000).padStart(6, '0');
}

async function call(method: string, path: string, body?: unknown, token?: string) {
  const started = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    // No Content-Type without a body: Fastify rejects a bodyless JSON request (400).
    headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ms = performance.now() - started;
  const text = await res.text();
  return { status: res.status, ms, json: text ? JSON.parse(text) : undefined };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (xs: number[]) =>
  `p50 ${pct(xs, 50).toFixed(1)} · p95 ${pct(xs, 95).toFixed(1)} · max ${Math.max(...xs).toFixed(1)} ms (n=${xs.length})`;

async function newUser(with2fa: boolean) {
  const email = `e10-${randomUUID().slice(0, 8)}@test.local`;
  const password = 'e10-password-123';
  const reg = await call('POST', '/auth/register', { email, password });
  if (reg.status !== 201) throw new Error(`register ${reg.status}`);
  let secret = '';
  if (with2fa) {
    const setup = await call('POST', '/auth/2fa/setup', undefined, reg.json.accessToken);
    secret = setup.json.secret;
    const on = await call('POST', '/auth/2fa/enable', { code: code(secret) }, reg.json.accessToken);
    if (on.status !== 200) throw new Error(`enable ${on.status} ${JSON.stringify(on.json)}`);
  }
  return { email, password, secret };
}

// a) Clock. GET /drops/:id answers with the server's time in ms; compare with the middle of our request.
console.log(`\n== E10a clock: API vs this machine, every 2 s for ${CLOCK_SECONDS} s`);
const offsets: { t: number; offset: number; rtt: number }[] = [];
const clockStart = Date.now();
while (Date.now() - clockStart < CLOCK_SECONDS * 1000) {
  const before = Date.now();
  const res = await fetch(`${BASE}/drops/${DROP_ID}`);
  const after = Date.now();
  const { serverTime } = (await res.json()) as { serverTime?: string };

  if (!serverTime) throw new Error('need an existing drop id (4th argument) for serverTime');
  offsets.push({ t: (before - clockStart) / 1000, offset: Date.parse(serverTime) - (before + after) / 2, rtt: after - before });
  await new Promise((r) => setTimeout(r, 2000));
}
const offs = offsets.map((o) => o.offset);
console.log(`samples ${offsets.length}, offset (API − here) min ${Math.min(...offs).toFixed(0)} · max ${Math.max(...offs).toFixed(0)} ms, rtt max ${Math.max(...offsets.map((o) => o.rtt))} ms`);
let jumps = 0;
for (let i = 1; i < offsets.length; i++) {
  const d = offsets[i].offset - offsets[i - 1].offset;
  if (Math.abs(d) > 100) {
    jumps++;
    console.log(`  jump at t=${offsets[i].t.toFixed(0)} s: ${d > 0 ? '+' : ''}${d.toFixed(0)} ms (offset now ${offsets[i].offset.toFixed(0)} ms)`);
  }
}
console.log(`jumps > 100 ms: ${jumps}; TOTP tolerates ±30 s (one step either side)`);

// b) Cost of the extra step.
console.log(`\n== E10b login cost, ${USERS} users with 2FA, ${USERS} without (sequential)`);
const plain = await Promise.all(Array.from({ length: USERS }, () => newUser(false)));
const withCode = [];
for (let i = 0; i < USERS; i++) withCode.push(await newUser(true));
const plainMs: number[] = [];
for (const u of plain) {
  const r = await call('POST', '/auth/login', { email: u.email, password: u.password });
  if (r.status !== 200 || !r.json.accessToken) throw new Error(`plain login ${r.status}`);
  plainMs.push(r.ms);
}
const passwordMs: number[] = [];
const codeMs: number[] = [];
for (const u of withCode) {
  const first = await call('POST', '/auth/login', { email: u.email, password: u.password });
  if (!first.json?.twoFactorRequired) throw new Error(`expected a challenge, got ${first.status}`);
  passwordMs.push(first.ms);
  // One step ahead: the step used to enable is spent (replay protection).
  const second = await call('POST', '/auth/login/2fa', { challengeToken: first.json.challengeToken, code: code(u.secret, 1) });
  if (second.status !== 200) throw new Error(`code step ${second.status} ${JSON.stringify(second.json)}`);
  codeMs.push(second.ms);
}
console.log(`plain login (no 2FA):  ${fmt(plainMs)}`);
console.log(`2FA step 1 (password): ${fmt(passwordMs)}`);
console.log(`2FA step 2 (code):     ${fmt(codeMs)}`);

// c) Guessing.
console.log('\n== E10c guessing codes');
const victim = await newUser(true);
const challenge = (await call('POST', '/auth/login', { email: victim.email, password: victim.password })).json.challengeToken;
const oneByOne: number[] = [];
for (let i = 0; i < 8; i++) oneByOne.push((await call('POST', '/auth/login/2fa', { challengeToken: challenge, code: String(200000 + i) })).status);
console.log(`8 wrong codes one by one → ${oneByOne.join(' ')}`);
const right = await call('POST', '/auth/login/2fa', { challengeToken: challenge, code: code(victim.secret, 1) });
console.log(`then the RIGHT code → ${right.status} ${right.json?.error ?? ''} (retry after ${right.json?.retryAfterSeconds ?? '-'} s)`);

const victim2 = await newUser(true);
const challenge2 = (await call('POST', '/auth/login', { email: victim2.email, password: victim2.password })).json.challengeToken;
const burst = await Promise.all(
  Array.from({ length: 30 }, (_, i) => call('POST', '/auth/login/2fa', { challengeToken: challenge2, code: String(300000 + i) })),
);
const tally = burst.reduce<Record<number, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
console.log(`30 wrong codes at once → ${JSON.stringify(tally)}`);
