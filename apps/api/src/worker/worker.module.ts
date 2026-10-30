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
 * The background process: outbox relay, notification consumer and cleanup jobs.
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
      ],
      controllers: [WorkerHealthController],
      providers: [{ provide: ENV, useValue: env }, OutboxRelay, CleanupService],
      exports: [ENV],
    };
  }
}
