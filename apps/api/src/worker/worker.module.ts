import { Controller, DynamicModule, Get, Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { InventoryCoreModule } from '../inventory/inventory-core.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { RabbitService } from '../messaging/rabbit.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { loggerModule } from '../observability/logger.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { OrdersCoreModule } from '../orders/orders-core.module.js';
import { OutboxRelay } from '../orders/outbox-relay.js';
import { DropsDataModule } from '../drops/drop-purchases.js';
import { CatalogDataModule } from '../catalog/search/product-indexer.js';
import { OrderExpiry } from '../orders/order-expiry.js';
import { PaymentCapturedConsumer } from '../orders/payment-captured.consumer.js';
import { PaymentsClient } from '../orders/payments-client.js';
import { ReadReplicaModule } from '../database/read-replica.js';
import { ReplicationHeartbeat } from '../orders/replication-heartbeat.js';
import { CleanupService } from './cleanup.service.js';

/**
 * Health for the worker. live = process alive. ready = connected to RabbitMQ, i.e.
 * actually doing its job (a worker without the broker should be noticed, not killed).
 */
@Controller('health')
class WorkerHealthController {
  constructor(private readonly rabbit: RabbitService) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  ready() {
    return { status: this.rabbit.isReady ? 'ok' : 'connecting', rabbitmq: this.rabbit.isReady };
  }
}

/**
 * The background process: outbox relay, notification consumer, cleanup, the payment.captured consumer and order
 * expiry (which asks the payments service before cancelling).
 * Same codebase and image as the API, different entry point (dist/worker.js), so it
 * scales separately: more API replicas for traffic, more workers for backlog.
 * It serves only /metrics and /health.
 */
@Module({})
export class WorkerModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: WorkerModule,
      global: true,
      imports: [
        loggerModule(env),
        ObservabilityModule,
        MessagingModule,
        OrdersCoreModule,
        InventoryCoreModule,
        NotificationsModule,
        DropsDataModule,
        // Phase 12: the catalog outbox (relay) and the search indexer.
        CatalogDataModule,
        // Phase 13: OrdersService reads through it (off in the worker: no DB_READ_HOST).
        ReadReplicaModule,
      ],
      controllers: [WorkerHealthController],
      providers: [
        { provide: ENV, useValue: env },
        OutboxRelay,
        CleanupService,
        // Phase 8: payments is its own service; the shop settles orders from its events and owns the deadline.
        PaymentCapturedConsumer,
        PaymentsClient,
        OrderExpiry,
        // Phase 13: the replica's heartbeat (one writer).
        ReplicationHeartbeat,
      ],
      exports: [ENV],
    };
  }
}
