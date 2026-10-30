import { DynamicModule, Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { CartModule } from './cart/cart.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { ENV, type Env } from './config/env.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { LabModule } from './lab/lab.module.js';
import { loggerModule } from './observability/logger.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { OrdersModule } from './orders/orders.module.js';

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        loggerModule(env),
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
