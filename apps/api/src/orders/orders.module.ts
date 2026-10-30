import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { UsersModule } from '../identity/users.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { MailerModule } from '../notifications/mailer.module.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { CheckoutService } from './checkout.service.js';
import { OrdersCoreModule } from './orders-core.module.js';
import { OrdersController } from './orders.controller.js';

@Module({
  imports: [
    OrdersCoreModule,
    CartModule,
    CatalogModule,
    InventoryModule,
    ObservabilityModule,
    // Only used by the lab's NOTIFY_MODE=sync; normally email goes through the outbox.
    UsersModule,
    MailerModule,
  ],
  controllers: [OrdersController],
  providers: [CheckoutService],
})
export class OrdersModule {}
