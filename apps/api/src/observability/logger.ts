import { LoggerModule } from 'nestjs-pino';
import type { Env } from '../config/env.js';

const QUIET_ROUTES = ['/metrics', '/health/live', '/health/ready'];

/** JSON logs (pino), shared by the API and the worker. */
export function loggerModule(env: Env) {
  return LoggerModule.forRoot({
    pinoHttp: {
      level: env.logLevel,
      base: { service: env.serviceName },
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
