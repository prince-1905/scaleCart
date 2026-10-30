import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module.js';
import { RabbitService } from './rabbit.service.js';

/** Only the worker imports this: the API never talks to RabbitMQ (it writes to the outbox). */
@Module({
  imports: [ObservabilityModule],
  providers: [RabbitService],
  exports: [RabbitService],
})
export class MessagingModule {}
