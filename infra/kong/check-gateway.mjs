// Checks the gateway's rules against the running Compose stack (through NGINX → Kong):
//   node infra/kong/check-gateway.mjs
// Secrets come from the repo-root .env and are never printed. Exits 1 if any check fails.
import { createHmac, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
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
// Phase 11: identity signs access tokens with RS256 and its key id. This tool reads identity's private key from .env
// (it runs on the developer's machine), so it can make tokens with chosen claims, to test what Kong lets through.
const KID = env.IDENTITY_SIGNING_KEY_ID;
const IDENTITY_KEY = Buffer.from(env.IDENTITY_SIGNING_KEY ?? '', 'base64').toString();
/** An RS256 token signed with `privateKey` (identity's by default). */
function token(claims, { privateKey = IDENTITY_KEY, kid = KID } = {}) {
  const head = `${b64url({ alg: 'RS256', typ: 'JWT', kid })}.${b64url(claims)}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(privateKey).toString('base64url')}`;
}
/** The pre-Phase-11 kind: HS256 with the shared JWT_SECRET. That secret must no longer be able to mint a login. */
function sharedSecretToken(claims) {
  const head = `${b64url({ alg: 'HS256', typ: 'JWT', kid: KID })}.${b64url(claims)}`;
  return `${head}.${createHmac('sha256', env.JWT_SECRET).update(head).digest('base64url')}`;
}
const strangerKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
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

r = await req('GET', '/cart', { auth: token({ sub: 'x', iss: 'scalecart', aud: 'scalecart-api', exp: now + 600 }, { privateKey: strangerKey }) });
check('signed with another key (but our key id) → 401 at the gateway', r.status === 401 && fromKong(r), `${r.status} ${r.text}`);

r = await req('GET', '/cart', { auth: sharedSecretToken({ sub: 'x', role: 'admin', iss: 'scalecart', aud: 'scalecart-api', exp: now + 600 }) });
check('the old shared secret (HS256) can no longer mint a login → 401 at the gateway', r.status === 401 && fromKong(r), `${r.status} ${r.text}`);

r = await req('GET', '/cart', { auth: token({ sub: 'x', iss: 'scalecart', aud: 'scalecart-api', exp: now - 60 }) });
check('expired token → 401 at the gateway', r.status === 401 && fromKong(r), `${r.status} ${r.text}`);

r = await req('GET', '/cart', { auth: token({ sub: 'x', iss: 'scalecart', aud: 'scalecart-api', exp: now + 600 }, { kid: 'no-such-key' }) });
check('unknown key id → 401 at the gateway', r.status === 401 && fromKong(r), `${r.status} ${r.text}`);

r = await req('GET', '/cart', { auth: token({ sub: 'x', iss: 'someone-else', aud: 'scalecart-api', exp: now + 600 }) });
check('wrong issuer → passes Kong (it checks key and expiry), refused by the shop', r.status === 401 && !fromKong(r), `${r.status} ${r.text}`);

r = await req('GET', '/cart', { auth: good });
check('valid token → reaches the shop (200)', r.status === 200, `${r.status} ${r.text.slice(0, 80)}`);

// Right key and issuer, wrong audience (like the 2FA challenge token): Kong lets it through, the shop refuses it.
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

// Phase 11: logins and users are the identity service's.
r = await req('GET', '/auth/me');
check('/auth/me without a token → 401 at the gateway', r.status === 401 && fromKong(r), `${r.status} ${r.text}`);
r = await req('GET', '/auth/me', { auth: good });
check('/auth/me with a token → answered by identity', r.status === 200 && JSON.parse(r.text).email === 'loadtest+7@scalecart.local', `${r.status} ${r.text.slice(0, 80)}`);
r = await req('GET', '/.well-known/jwks.json');
check('the public key set is public, and has our key id', r.status === 200 && JSON.parse(r.text).keys?.some((k) => k.kid === KID), r.status);
r = await req('GET', `/internal/users?ids=${randomUUID()}`, { headers: { 'x-service-token': 'guess' } });
check("identity's internal email lookup → 404 at the gateway", r.status === 404 && fromKong(r), `${r.status} ${r.text}`);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
