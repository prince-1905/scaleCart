// Checks the gateway's rules against the running Compose stack (through NGINX → Kong):
//   node infra/kong/check-gateway.mjs
// Secrets come from the repo-root .env and are never printed. Exits 1 if any check fails.
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const BASE = process.env.BASE_URL ?? 'http://localhost:8088';

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
/** An HS256 token like the shop's, with whatever claims and secret we choose. */
function token(claims, secret = env.JWT_SECRET) {
  const head = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
}
const now = Math.floor(Date.now() / 1000);

async function req(method, path, { auth, headers = {}, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(auth && { authorization: `Bearer ${auth}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`);
  if (!ok) failed++;
}
/** Kong's own refusals have a different body from the shop's ({"statusCode":401,…}). */
const fromKong = (r) => !r.text.includes('statusCode');

// A real customer token from the shop.
const login = await req('POST', '/auth/login', {
  body: { email: 'loadtest+7@scalecart.local', password: env.SEED_USER_PASSWORD },
});
const good = JSON.parse(login.text).accessToken;
check('login (public route) works through the gateway', login.status === 200 && !!good, login.status);

let r = await req('GET', '/products/1');
check('browsing needs no token', r.status === 200, r.status);
const rid = r.headers.get('x-request-id');
check('every response gets an X-Request-ID', /^[0-9a-f-]{36}$/.test(rid ?? ''), rid);

r = await req('GET', '/cart');
check('no token on a protected route → 401 at the gateway', r.status === 401 && fromKong(r), `${r.status} ${r.text}`);

r = await req('GET', '/cart', { auth: token({ sub: 'x', iss: 'scalecart', aud: 'scalecart-api', exp: now + 600 }, 'not-the-secret-not-the-secret-123') });
check('forged signature → 401 at the gateway', r.status === 401 && fromKong(r), `${r.status} ${r.text}`);

r = await req('GET', '/cart', { auth: token({ sub: 'x', iss: 'scalecart', aud: 'scalecart-api', exp: now - 60 }) });
check('expired token → 401 at the gateway', r.status === 401 && fromKong(r), `${r.status} ${r.text}`);

r = await req('GET', '/cart', { auth: token({ sub: 'x', iss: 'someone-else', exp: now + 600 }) });
check('unknown issuer → 401 at the gateway', r.status === 401 && fromKong(r), `${r.status} ${r.text}`);

r = await req('GET', '/cart', { auth: good });
check('valid token → reaches the shop (200)', r.status === 200, `${r.status} ${r.text.slice(0, 80)}`);

// Right secret and issuer, wrong audience (like the 2FA challenge token): Kong lets it through, the shop refuses it.
r = await req('GET', '/cart', { auth: token({ sub: 'x', iss: 'scalecart', aud: 'scalecart-2fa', exp: now + 300 }) });
check('wrong audience → passes Kong, refused by the shop (defense in depth)', r.status === 401 && !fromKong(r), `${r.status} ${r.text}`);

r = await req('GET', `/internal/orders/${randomUUID()}`, { auth: good, headers: { 'x-service-token': 'guess' } });
check('/internal/* → 404 at the gateway', r.status === 404 && fromKong(r), `${r.status} ${r.text}`);
r = await req('GET', '/metrics');
check('/metrics → 404 at the gateway', r.status === 404 && fromKong(r), `${r.status} ${r.text}`);

r = await req('POST', `/orders/${randomUUID()}/payment`);
check('Pay without a token → 401 at the gateway', r.status === 401 && fromKong(r), `${r.status} ${r.text}`);
r = await req('POST', `/orders/${randomUUID()}/payment`, { auth: good });
check('Pay with a token → routed to payments (404 unknown order)', r.status === 404 && !fromKong(r), `${r.status} ${r.text}`);

r = await req('POST', '/payments/razorpay/webhook', { headers: { 'x-razorpay-signature': 'bad' }, body: { event: 'x' } });
check('webhook needs no token, payments checks its signature (400)', r.status === 400 && !fromKong(r), `${r.status} ${r.text}`);

r = await req('POST', '/products', { auth: good, body: {} });
check('admin route with a customer token → passes Kong, the shop refuses (403)', r.status === 403, `${r.status} ${r.text}`);

r = await req('GET', '/drops');
check('drop list is public', r.status === 200, r.status);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
