import { Module } from '@nestjs/common';
import { moduleTypeOrm } from '../database/module-typeorm.js';
import { UsersModule } from '../identity/users.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { MailerModule } from './mailer.module.js';
import { notificationsDatabase } from './notifications.database.js';
import { OrderCreatedConsumer } from './order-created.consumer.js';

/** Worker-side: consumes order events and sends emails. Owns the notifications database. */
@Module({
  imports: [
    ...moduleTypeOrm(notificationsDatabase),
    MessagingModule,
    MailerModule,
    UsersModule,
    ObservabilityModule,
  ],
  providers: [OrderCreatedConsumer],
})
export class NotificationsModule {}
