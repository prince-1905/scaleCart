import { loadEnv } from './env.js';

const SECRET = 'x'.repeat(32);

describe('loadEnv', () => {
  it('uses safe defaults', () => {
    expect(loadEnv({ JWT_SECRET: SECRET })).toEqual({
      port: 3000,
      httpAdapter: 'fastify',
      logLevel: 'info',
      httpAccessLog: true,
      labEndpoints: false,
      serviceName: 'scalecart-api',
      db: {
        host: '127.0.0.1',
        port: 3307,
        user: 'scalecart',
        password: '',
        databasePrefix: 'scalecart_',
        poolSize: 5,
      },
      jwtSecret: SECRET,
      accessTokenTtlSeconds: 900,
      refreshTokenTtlDays: 30,
      stockReservation: 'atomic',
      listenBacklog: 4096,
      redisUrl: 'redis://127.0.0.1:6379',
      cacheEnabled: true,
      cacheTtlSeconds: 60,
      loginMaxFailures: 5,
      loginFailureWindowSeconds: 900,
      apiDocs: true,
    });
  });

  it('parses overrides', () => {
    const env = loadEnv({
      JWT_SECRET: SECRET,
      PORT: '8080',
      HTTP_ADAPTER: 'Express',
      HTTP_ACCESS_LOG: 'false',
      LAB_ENDPOINTS: 'true',
      DB_HOST: 'mysql',
      DB_PORT: '3306',
      DB_POOL_SIZE: '10',
      STOCK_RESERVATION: 'naive',
    });
    expect(env).toMatchObject({
      port: 8080,
      httpAdapter: 'express',
      httpAccessLog: false,
      labEndpoints: true,
      db: { host: 'mysql', port: 3306, poolSize: 10 },
      stockReservation: 'naive',
    });
  });

  it('rejects an unknown adapter', () => {
    expect(() => loadEnv({ JWT_SECRET: SECRET, HTTP_ADAPTER: 'koa' })).toThrow(/HTTP_ADAPTER/);
  });

  it('rejects an invalid port', () => {
    expect(() => loadEnv({ JWT_SECRET: SECRET, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('requires a long JWT secret', () => {
    expect(() => loadEnv({})).toThrow(/JWT_SECRET/);
    expect(() => loadEnv({ JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('only allows the unsafe stock strategies in lab mode', () => {
    expect(() => loadEnv({ JWT_SECRET: SECRET, STOCK_RESERVATION: 'naive' })).toThrow(
      /LAB_ENDPOINTS/,
    );
    expect(() =>
      loadEnv({ JWT_SECRET: SECRET, LAB_ENDPOINTS: 'true', STOCK_RESERVATION: 'magic' }),
    ).toThrow(/STOCK_RESERVATION/);
  });
});
