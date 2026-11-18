import { DynamicModule, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthGuard } from './common/auth.js';
import { ENV, type PaymentsEnv } from './config/env.js';
import { mysqlOptions } from './database/database.js';
import { HealthController } from './health/health.controller.js';
import { OutboxRelay } from './messaging/outbox-relay.js';
import { RabbitService } from './messaging/rabbit.service.js';
import { loggerModule } from './observability/logger.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payments/payment-gateway.js';
import { PaymentEvents } from './payments/payment-events.js';
import { PaymentJobs } from './payments/payment-jobs.js';
import { PaymentsController } from './payments/payments.controller.js';
import { PaymentsService } from './payments/payments.service.js';
import { RazorpayGateway } from './payments/razorpay-gateway.js';
import { WebhookService } from './payments/webhook.service.js';
import { ShopClient } from './shop/shop-client.js';

/**
 * The payments service: one process with HTTP (customers, Razorpay, the shop's internal calls), the outbox relay,
 * the order.payment_result consumer and the refund job. Its only database is scalecart_payments.
 */
@Module({})
export class AppModule {
  static forRoot(env: PaymentsEnv, options: { gateway?: PaymentGateway | null } = {}): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        loggerModule(env),
        ObservabilityModule,
        TypeOrmModule.forRoot({ ...mysqlOptions(env.db), retryAttempts: 5, retryDelay: 2_000 }),
        // Verify only, with exactly the shop's settings: same secret, algorithm, issuer and audience.
        JwtModule.register({
          secret: env.jwtSecret,
          verifyOptions: { algorithms: ['HS256'], issuer: 'scalecart', audience: 'scalecart-api' },
        }),
      ],
      controllers: [PaymentsController, HealthController],
      providers: [
        { provide: ENV, useValue: env },
        {
          provide: PAYMENT_GATEWAY,
          // Tests pass a fake Razorpay; no keys = payments off (routes answer 503).
          useValue:
            options.gateway !== undefined
              ? options.gateway
              : env.razorpayKeyId && env.razorpayKeySecret
                ? new RazorpayGateway(env.razorpayKeyId, env.razorpayKeySecret)
                : null,
        },
        { provide: APP_GUARD, useClass: AuthGuard },
        {
          provide: APP_PIPE,
          useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
        },
        ShopClient,
        RabbitService,
        OutboxRelay,
        PaymentsService,
        WebhookService,
        PaymentEvents,
        PaymentJobs,
      ],
      exports: [ENV],
    };
  }
}
