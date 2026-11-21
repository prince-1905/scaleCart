import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createPublicKey, randomUUID } from 'node:crypto';
import { http, KEY, KID, newTestKey, registerUser, SERVICE_TOKEN, startIdentity, type TestUser } from './support.js';

const decodeHeader = (token: string) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());

describe('signing keys and the public key set (Phase 11)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startIdentity();
  });
  afterAll(async () => {
    await app.close();
  });

  it('access tokens are RS256 with our key id in the header, and carry the email', async () => {
    const user = await registerUser(app);
    expect(decodeHeader(user.accessToken)).toMatchObject({ alg: 'RS256', kid: KID });
    // The user's own address rides in the token (E14b): services never call identity for it.
    const payload = JSON.parse(Buffer.from(user.accessToken.split('.')[1], 'base64url').toString());
    expect(payload).toMatchObject({ email: user.email, role: 'customer' });
  });

  it('/.well-known/jwks.json: the public key that checks our tokens, and nothing secret', async () => {
    const user = await registerUser(app);
    const res = await http(app).get('/.well-known/jwks.json').expect(200);
    expect(res.headers['cache-control']).toContain('max-age=300');
    const [jwk] = res.body.keys;
    expect(jwk).toMatchObject({ kty: 'RSA', kid: KID, alg: 'RS256', use: 'sig' });
    // The private parts of an RSA key would be d, p, q, dp, dq, qi: never published.
    for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi']) expect(jwk).not.toHaveProperty(secret);

    // Anyone holding only this public key can check a token…
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' }) as string;
    const claims = new JwtService().verify(user.accessToken, { publicKey, algorithms: ['RS256'] });
    expect(claims).toMatchObject({ iss: 'scalecart', aud: 'scalecart-api', role: 'customer' });
  });

  it('…but a token signed with any other key is refused, even with our key id', async () => {
    const stranger = Buffer.from(newTestKey().privateB64, 'base64').toString();
    const forged = new JwtService({ privateKey: stranger }).sign(
      { sub: randomUUID(), role: 'admin' },
      { algorithm: 'RS256', keyid: KID, issuer: 'scalecart', audience: 'scalecart-api', expiresIn: 900 },
    );
    await http(app).get('/auth/me').auth(forged, { type: 'bearer' }).expect(401);
  });

  it('internal user lookup: emails for ids, service token only', async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const idOf = async (u: TestUser) =>
      (await http(app).get('/auth/me').auth(u.accessToken, { type: 'bearer' }).expect(200)).body.id as string;
    const ids = [await idOf(a), await idOf(b), randomUUID()];

    await http(app).get(`/internal/users?ids=${ids.join(',')}`).expect(401);
    await http(app).get(`/internal/users?ids=${ids.join(',')}`).set('x-service-token', 'wrong').expect(401);
    const res = await http(app).get(`/internal/users?ids=${ids.join(',')}`).set('x-service-token', SERVICE_TOKEN).expect(200);
    expect(res.body.users).toHaveLength(2); // the unknown id is left out
    expect(res.body.users).toEqual(expect.arrayContaining([{ id: ids[0], email: a.email }, { id: ids[1], email: b.email }]));
    // A customer's token is no service token.
    await http(app).get(`/internal/users?ids=${ids[0]}`).auth(a.accessToken, { type: 'bearer' }).expect(401);
  });
});

describe('key rotation', () => {
  it('after switching to a new key, tokens signed with the old one still work until they expire', async () => {
    // Before: signing with the old key.
    const before = await startIdentity();
    const user = await registerUser(before);
    await before.close();

    // After: a new signing key; the old public key stays in the accepted list.
    const next = newTestKey();
    const after = await startIdentity({
      IDENTITY_SIGNING_KEY: next.privateB64,
      IDENTITY_SIGNING_KEY_ID: 'test-key-2',
      IDENTITY_EXTRA_PUBLIC_KEYS: `${KID}:${KEY.publicB64}`,
    });
    try {
      await http(after).get('/auth/me').auth(user.accessToken, { type: 'bearer' }).expect(200);
      const fresh = (await http(after).post('/auth/login').send({ email: user.email, password: user.password }).expect(200)).body;
      expect(decodeHeader(fresh.accessToken).kid).toBe('test-key-2');
      const jwks = (await http(after).get('/.well-known/jwks.json').expect(200)).body.keys.map((k: { kid: string }) => k.kid);
      expect(jwks.sort()).toEqual([KID, 'test-key-2']);
    } finally {
      await after.close();
    }

    // Once the old key is dropped from the list, its tokens stop working.
    const dropped = await startIdentity({ IDENTITY_SIGNING_KEY: next.privateB64, IDENTITY_SIGNING_KEY_ID: 'test-key-2' });
    try {
      await http(dropped).get('/auth/me').auth(user.accessToken, { type: 'bearer' }).expect(401);
    } finally {
      await dropped.close();
    }
  });
});

describe('login protection (moved from the shop with logins, Phase 11)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startIdentity();
  });
  afterAll(async () => {
    await app.close();
  });

  const fail = (u: TestUser) => http(app).post('/auth/login').send({ email: u.email, password: 'wrong-password' });

  it('refuses logins for an account after 5 failures, even with the right password', async () => {
    const user = await registerUser(app);
    for (let i = 0; i < 5; i++) await fail(user).expect(401);
    const blocked = await http(app).post('/auth/login').send({ email: user.email, password: user.password }).expect(429);
    expect(blocked.body).toMatchObject({ error: 'too_many_failed_logins' });
    expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('resets the count after a successful login', async () => {
    const user = await registerUser(app);
    for (let i = 0; i < 4; i++) await fail(user).expect(401);
    await http(app).post('/auth/login').send({ email: user.email, password: user.password }).expect(200);
    for (let i = 0; i < 4; i++) await fail(user).expect(401);
  });

  it('login is limited per IP, whatever the email (many accounts from one address)', async () => {
    const limited = await startIdentity({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_AUTH: '3:0.01' });
    try {
      const login = (email: string) => http(limited).post('/auth/login').send({ email, password: 'wrong-password-123' });
      for (const email of ['a@x.local', 'b@x.local', 'c@x.local']) await login(email).expect(401);
      const refused = await login('d@x.local').expect(429);
      expect(refused.body.error).toBe('rate_limited');
    } finally {
      await limited.close();
    }
  });
});
