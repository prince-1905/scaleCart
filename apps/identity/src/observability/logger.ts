import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { LoggerModule } from 'nestjs-pino';
import type { Env } from '../config/env.js';

const QUIET_ROUTES = ['/metrics', '/health/live', '/health/ready'];

/** JSON logs (pino), shared by the API and the worker. */
export function loggerModule(env: Env) {
  return LoggerModule.forRoot({
    pinoHttp: {
      level: env.logLevel,
      base: { service: env.serviceName },
      // The gateway's X-Request-ID (Phase 9) becomes the log's request id; a request that didn't come through the
      // gateway (tests, service-to-service calls without one) gets a fresh id.
      genReqId: (req: IncomingMessage) => requestIdOf(req),
      // Never log credentials, even by accident.
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[REDACTED]',
      },
      autoLogging: env.httpAccessLog
        ? { ignore: (req) => QUIET_ROUTES.includes(req.url ?? '') }
        : false,
    },
  });
}

/** A well-formed X-Request-ID from the caller, or a new one. Bounded, so a client can't stuff the logs. */
export function requestIdOf(req: IncomingMessage): string {
  const id = req.headers['x-request-id'];
  return typeof id === 'string' && /^[\w.:-]{1,64}$/.test(id) ? id : randomUUID();
}
