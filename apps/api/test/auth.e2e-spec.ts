import type { INestApplication } from '@nestjs/common';
import type { HttpAdapterName } from '../src/config/env.js';
import { http, registerUser, startApp, unique } from './support.js';

describe.each<HttpAdapterName>(['fastify', 'express'])('auth on %s', (adapter) => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await startApp(adapter);
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers, then identifies the user from the access token', async () => {
    const user = await registerUser(app);
    expect(user).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });

    const me = await http(app).get('/auth/me').auth(user.accessToken, { type: 'bearer' }).expect(200);
    expect(me.body).toMatchObject({ email: user.email, role: 'customer' });
  });

  it('rejects a second account with the same email, in any letter case', async () => {
    const user = await registerUser(app);
    await http(app)
      .post('/auth/register')
      .send({ email: user.email.toUpperCase(), password: 'another-password' })
      .expect(409);
  });

  it('rejects unknown fields, so nobody can register as admin', async () => {
    await http(app)
      .post('/auth/register')
      .send({ email: `${unique('x')}@test.local`, password: 'long-enough-pw', role: 'admin' })
      .expect(400);
  });

  it('protects routes by default', async () => {
    await http(app).get('/auth/me').expect(401);
    await http(app).get('/auth/me').auth('not-a-jwt', { type: 'bearer' }).expect(401);
    await http(app).get('/cart').expect(401);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const user = await registerUser(app);
    const wrong = await http(app)
      .post('/auth/login')
      .send({ email: user.email, password: 'wrong-password' })
      .expect(401);
    const unknown = await http(app)
      .post('/auth/login')
      .send({ email: `${unique('nobody')}@test.local`, password: 'wrong-password' })
      .expect(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('rotates refresh tokens and revokes the whole family when one is reused', async () => {
    const user = await registerUser(app);

    const first = await http(app)
      .post('/auth/refresh')
      .send({ refreshToken: user.refreshToken })
      .expect(200);
    expect(first.body.refreshToken).not.toBe(user.refreshToken);

    // Replaying the old token looks like theft: it fails...
    await http(app).post('/auth/refresh').send({ refreshToken: user.refreshToken }).expect(401);
    // ...and the token issued to the legitimate holder is revoked with it.
    await http(app)
      .post('/auth/refresh')
      .send({ refreshToken: first.body.refreshToken })
      .expect(401);
  });

  it('lets exactly one of two simultaneous refreshes with the same token win', async () => {
    const user = await registerUser(app);
    const results = await Promise.all(
      [1, 2].map(() =>
        http(app).post('/auth/refresh').send({ refreshToken: user.refreshToken }),
      ),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 401]);
  });

  it('logout ends the session', async () => {
    const user = await registerUser(app);
    await http(app).post('/auth/logout').send({ refreshToken: user.refreshToken }).expect(204);
    await http(app).post('/auth/refresh').send({ refreshToken: user.refreshToken }).expect(401);
  });
});
