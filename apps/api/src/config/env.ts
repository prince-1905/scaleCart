/**
 * Typed, validated environment configuration.
 *
 * Read once at startup (before Nest boots) because some values — like which
 * HTTP adapter to use — must be known before the application is created.
 */
export type HttpAdapterName = 'fastify' | 'express';

export interface Env {
  port: number;
  httpAdapter: HttpAdapterName;
  logLevel: string;
  /** Per-request access logs. Disable during load tests: logging every request costs real CPU. */
  httpAccessLog: boolean;
  /** Exposes /lab/* endpoints used for performance experiments. Never enable in production. */
  labEndpoints: boolean;
  serviceName: string;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const port = Number(source.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${source.PORT}`);
  }

  const httpAdapter = (source.HTTP_ADAPTER ?? 'fastify').toLowerCase();
  if (httpAdapter !== 'fastify' && httpAdapter !== 'express') {
    throw new Error(`Invalid HTTP_ADAPTER: ${source.HTTP_ADAPTER} (expected fastify|express)`);
  }

  return {
    port,
    httpAdapter,
    logLevel: source.LOG_LEVEL ?? 'info',
    httpAccessLog: bool(source.HTTP_ACCESS_LOG, true),
    labEndpoints: bool(source.LAB_ENDPOINTS, false),
    serviceName: source.SERVICE_NAME ?? 'scalecart-api',
  };
}

export const ENV = Symbol('ENV');
