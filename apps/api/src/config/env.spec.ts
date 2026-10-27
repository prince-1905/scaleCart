import { loadEnv } from './env.js';

describe('loadEnv', () => {
  it('uses safe defaults', () => {
    expect(loadEnv({})).toEqual({
      port: 3000,
      httpAdapter: 'fastify',
      logLevel: 'info',
      httpAccessLog: true,
      labEndpoints: false,
      serviceName: 'scalecart-api',
    });
  });

  it('parses overrides', () => {
    const env = loadEnv({
      PORT: '8080',
      HTTP_ADAPTER: 'Express',
      HTTP_ACCESS_LOG: 'false',
      LAB_ENDPOINTS: 'true',
    });
    expect(env).toMatchObject({
      port: 8080,
      httpAdapter: 'express',
      httpAccessLog: false,
      labEndpoints: true,
    });
  });

  it('rejects an unknown adapter', () => {
    expect(() => loadEnv({ HTTP_ADAPTER: 'koa' })).toThrow(/HTTP_ADAPTER/);
  });

  it('rejects an invalid port', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(/PORT/);
  });
});
