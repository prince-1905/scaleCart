import type { INestApplication } from '@nestjs/common';
import { hotp, totpStep } from '../src/identity/totp.js';
import { dataSource, http, registerUser, startIdentity, type TestUser } from './support.js';

/** The authenticator app's side: base32 secret → current code (optionally a few steps ahead). */
function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
const codeFor = (secret: string, stepsAhead = 0) => hotp(base32Decode(secret), totpStep(Date.now()) + stepsAhead);

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('two-factor login (moved from the shop, Phase 11)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await startIdentity({ TWO_FACTOR_MAX_FAILURES: '5' });
  });
  afterAll(async () => {
    await app.close();
  });

  /** A user with 2FA switched on; the code used to enable it was for the current step. */
  async function userWith2fa(): Promise<TestUser & { secret: string; backupCodes: string[] }> {
    const user = await registerUser(app);
    const setup = await http(app).post('/auth/2fa/setup').set(bearer(user.accessToken)).expect(200);
    const enabled = await http(app)
      .post('/auth/2fa/enable')
      .set(bearer(user.accessToken))
      .send({ code: codeFor(setup.body.secret) })
      .expect(200);
    return { ...user, secret: setup.body.secret, backupCodes: enabled.body.backupCodes };
  }
  const login = (user: TestUser) => http(app).post('/auth/login').send({ email: user.email, password: user.password });
  const second = (challengeToken: string, code: string) =>
    http(app).post('/auth/login/2fa').send({ challengeToken, code });

  it('setup → QR link and secret; enable with the first code → 10 backup codes; /me says on', async () => {
    const user = await registerUser(app);
    const setup = await http(app).post('/auth/2fa/setup').set(bearer(user.accessToken)).expect(200);
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.otpauthUrl).toContain(`secret=${setup.body.secret}`);
    expect(setup.body.otpauthUrl).toContain('issuer=ScaleCart');

    // Not on until confirmed: login still gives tokens directly.
    expect((await login(user).expect(200)).body.accessToken).toBeTruthy();
    // 400, not 401: a signed-in user's wrong code must not look like an expired token (clients would refresh and resend it).
    await http(app).post('/auth/2fa/enable').set(bearer(user.accessToken)).send({ code: '000000' }).expect(400);

    const enabled = await http(app)
      .post('/auth/2fa/enable')
      .set(bearer(user.accessToken))
      .send({ code: codeFor(setup.body.secret) })
      .expect(200);
    expect(enabled.body.backupCodes).toHaveLength(10);
    expect(enabled.body.backupCodes[0]).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
    const me = await http(app).get('/auth/me').set(bearer(user.accessToken)).expect(200);
    expect(me.body.twoFactorEnabled).toBe(true);
    await http(app).post('/auth/2fa/setup').set(bearer(user.accessToken)).expect(409);
  });

  it('the secret is stored encrypted, never as the base32 the user saw', async () => {
    const user = await userWith2fa();
    const [row] = await dataSource(app, 'identity').query(
      `SELECT t.secret_enc FROM user_totp t JOIN users u ON u.id = t.user_id WHERE u.email = ?`,
      [user.email],
    );
    const raw = base32Decode(user.secret);
    expect(Buffer.from(row.secret_enc).includes(raw)).toBe(false);
    expect(Buffer.from(row.secret_enc).length).toBe(12 + raw.length + 16);
  });

  it('login: password → challenge (no tokens) → code → tokens', async () => {
    const user = await userWith2fa();
    const first = await login(user).expect(200);
    expect(first.body).toMatchObject({ twoFactorRequired: true, expiresIn: 300 });
    expect(first.body.accessToken).toBeUndefined();

    // The challenge is not an access token.
    await http(app).get('/auth/me').set(bearer(first.body.challengeToken)).expect(401);

    const tokens = await second(first.body.challengeToken, codeFor(user.secret, 1)).expect(200);
    await http(app).get('/auth/me').set(bearer(tokens.body.accessToken)).expect(200);
  });

  it('a code that already logged someone in cannot be used again (replay)', async () => {
    const user = await userWith2fa();
    const code = codeFor(user.secret, 1);
    await second((await login(user)).body.challengeToken, code).expect(200);
    const replay = await second((await login(user)).body.challengeToken, code).expect(401);
    expect(replay.body.error).toBe('invalid_code');
    // The code the account was enabled with is older still.
    await second((await login(user)).body.challengeToken, codeFor(user.secret)).expect(401);
  });

  it('5 wrong codes lock the check: even the right code is refused with 429', async () => {
    const user = await userWith2fa();
    const { challengeToken } = (await login(user)).body;
    for (let i = 0; i < 5; i++) await second(challengeToken, '000000').expect(401);
    const locked = await second(challengeToken, codeFor(user.secret, 1)).expect(429);
    expect(locked.body).toMatchObject({ error: 'two_factor_locked' });
    expect(locked.body.retryAfterSeconds).toBeGreaterThan(800);
  });

  it('30 guesses at the same moment: exactly 5 are checked, the rest get 429', async () => {
    const user = await userWith2fa();
    const { challengeToken } = (await login(user)).body;
    const statuses = await Promise.all(
      Array.from({ length: 30 }, (_, i) => second(challengeToken, String(100000 + i)).then((r) => r.status)),
    );
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(25);
  });

  it('a backup code works once, with or without the dash', async () => {
    const user = await userWith2fa();
    const backup = user.backupCodes[3];
    await second((await login(user)).body.challengeToken, backup.replace('-', '').toUpperCase()).expect(200);
    await second((await login(user)).body.challengeToken, backup).expect(401);
  });

  it('a forged or wrong-kind challenge is refused', async () => {
    const user = await userWith2fa();
    await second('not-a-token', codeFor(user.secret, 1)).expect(401);
    // A real access token is not a challenge either.
    await second(user.accessToken, codeFor(user.secret, 1)).expect(401);
  });

  it('turning it off needs a valid code; afterwards login gives tokens directly again', async () => {
    const user = await userWith2fa();
    await http(app).post('/auth/2fa/disable').set(bearer(user.accessToken)).send({ code: '123456' }).expect(400);
    await http(app)
      .post('/auth/2fa/disable')
      .set(bearer(user.accessToken))
      .send({ code: codeFor(user.secret, 1) })
      .expect(204);
    expect((await login(user).expect(200)).body.accessToken).toBeTruthy();
    const me = await http(app).get('/auth/me').set(bearer(user.accessToken)).expect(200);
    expect(me.body.twoFactorEnabled).toBe(false);
  });

  it('new backup codes replace the old ones', async () => {
    const user = await userWith2fa();
    const fresh = await http(app)
      .post('/auth/2fa/backup-codes')
      .set(bearer(user.accessToken))
      .send({ code: codeFor(user.secret, 1) })
      .expect(200);
    expect(fresh.body.backupCodes).toHaveLength(10);
    await second((await login(user)).body.challengeToken, user.backupCodes[0]).expect(401);
    await second((await login(user)).body.challengeToken, fresh.body.backupCodes[0]).expect(200);
  });
});
