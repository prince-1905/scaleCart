import { DynamicModule, Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { CartModule } from './cart/cart.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { ENV, type Env } from './config/env.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { LabModule } from './lab/lab.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { OrdersModule } from './orders/orders.module.js';

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
        IdentityModule,
        CatalogModule,
        InventoryModule,
        CartModule,
        OrdersModule,
        ...(env.labEndpoints ? [LabModule] : []),
      ],
      providers: [
        { provide: ENV, useValue: env },
        {
          provide: APP_PIPE,
          // whitelist + forbidNonWhitelisted: unknown fields are rejected, so a client
          // can't sneak in e.g. "role": "admin" or "priceCents": 1.
          useValue: new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
          }),
        },
      ],
      exports: [ENV],
    };
  }
}
