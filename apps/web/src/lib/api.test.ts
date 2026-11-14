import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, tokens } from './api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api client', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('sends the access token and parses JSON', async () => {
    tokens.set({ accessToken: 'A1', refreshToken: 'R1', expiresIn: 900 });
    const fetchMock = vi.fn(async () => json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await api('/cart')).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer A1');
  });

  it('sends no Content-Type without a body (Fastify rejects an empty JSON body)', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await api('/cart', { method: 'DELETE' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('three requests with an expired token share ONE refresh, then retry with the new token', async () => {
    tokens.set({ accessToken: 'old', refreshToken: 'R1', expiresIn: 900 });
    let refreshes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init: RequestInit) => {
        if (path === '/auth/refresh') {
          refreshes++;
          await new Promise((r) => setTimeout(r, 10));
          return json(200, { accessToken: 'new', refreshToken: 'R2', expiresIn: 900 });
        }
        const auth = (init.headers as Record<string, string>).authorization;
        return auth === 'Bearer new' ? json(200, { path }) : json(401, { message: 'expired' });
      }),
    );

    const results = await Promise.all([api('/cart'), api('/orders'), api('/auth/me')]);

    expect(refreshes).toBe(1); // a second refresh with the same token would look like theft to the API
    expect(results).toEqual([{ path: '/cart' }, { path: '/orders' }, { path: '/auth/me' }]);
    expect(tokens.get()?.refreshToken).toBe('R2');
  });

  it('a refused refresh logs the user out and surfaces the 401', async () => {
    tokens.set({ accessToken: 'old', refreshToken: 'stolen', expiresIn: 900 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => (path === '/auth/refresh' ? json(401, { message: 'revoked' }) : json(401, { message: 'expired' }))),
    );

    const err = (await api('/cart').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(tokens.get()).toBeNull();
  });

  it('exposes our error codes and joins validation messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { statusCode: 409, error: 'out_of_stock', message: 'sold out' })));
    const soldOut = (await api('/checkout', { method: 'POST', body: {} }).catch((e: unknown) => e)) as ApiError;
    expect(soldOut.code).toBe('out_of_stock');

    vi.stubGlobal('fetch', vi.fn(async () => json(400, { message: ['email must be an email', 'password too short'] })));
    const invalid = (await api('/auth/register', { method: 'POST', body: {} }).catch((e: unknown) => e)) as ApiError;
    expect(invalid.message).toBe('email must be an email, password too short');
  });
});
