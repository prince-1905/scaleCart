import { DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ENV, type Env } from './config/env.js';
import { HealthModule } from './health/health.module.js';
import { LabModule } from './lab/lab.module.js';
import { ObservabilityModule } from './observability/observability.module.js';

const QUIET_ROUTES = ['/metrics', '/health/live', '/health/ready'];

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: env.logLevel,
            base: { service: env.serviceName },
            // Never log credentials, even by accident.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
              ],
              censor: '[REDACTED]',
            },
            autoLogging: env.httpAccessLog
              ? { ignore: (req) => QUIET_ROUTES.includes(req.url ?? '') }
              : false,
          },
        }),
        ObservabilityModule,
        HealthModule,
        ...(env.labEndpoints ? [LabModule] : []),
      ],
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
