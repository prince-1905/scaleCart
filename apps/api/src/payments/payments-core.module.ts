import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { moduleTypeOrm } from '../database/module-typeorm.js';
import { InventoryCoreModule } from '../inventory/inventory-core.module.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { OrdersCoreModule } from '../orders/orders-core.module.js';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway.js';
import { paymentsDatabase } from './payments.database.js';
import { PaymentsService } from './payments.service.js';
import { RazorpayGateway } from './razorpay-gateway.js';
import { WebhookService } from './webhook.service.js';

/** Payments without HTTP: used by the API (via PaymentsModule) and by the worker's jobs. */
@Module({
  imports: [...moduleTypeOrm(paymentsDatabase), OrdersCoreModule, InventoryCoreModule, ObservabilityModule],
  providers: [
    {
      provide: PAYMENT_GATEWAY,
      inject: [ENV],
      // No keys = payments off: the routes answer 503, the shop itself keeps working.
      useFactory: (env: Env): PaymentGateway | null =>
        env.razorpayKeyId && env.razorpayKeySecret
          ? new RazorpayGateway(env.razorpayKeyId, env.razorpayKeySecret)
          : null,
    },
    PaymentsService,
    WebhookService,
  ],
  exports: [PaymentsService, WebhookService],
})
export class PaymentsCoreModule {}
