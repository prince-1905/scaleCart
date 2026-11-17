import { LoggerModule } from 'nestjs-pino';
import type { PaymentsEnv } from '../config/env.js';

const QUIET_ROUTES = ['/metrics', '/health/live', '/health/ready'];

/** JSON logs (pino), like the shop's. */
export function loggerModule(env: PaymentsEnv) {
  return LoggerModule.forRoot({
    pinoHttp: {
      level: env.logLevel,
      base: { service: env.serviceName },
      // Never log credentials: login tokens, the service token, Razorpay signatures.
      redact: {
        paths: ['req.headers.authorization', 'req.headers["x-service-token"]', 'req.headers["x-razorpay-signature"]'],
        censor: '[REDACTED]',
      },
      autoLogging: env.httpAccessLog ? { ignore: (req) => QUIET_ROUTES.includes(req.url ?? '') } : false,
    },
  });
}
