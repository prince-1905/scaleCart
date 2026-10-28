import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { moduleTypeOrm } from '../database/module-typeorm.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { CheckoutService } from './checkout.service.js';
import { OrdersController } from './orders.controller.js';
import { ordersDatabase } from './orders.database.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [
    ...moduleTypeOrm(ordersDatabase),
    CartModule,
    CatalogModule,
    InventoryModule,
    ObservabilityModule,
  ],
  controllers: [OrdersController],
  providers: [CheckoutService, OrdersService],
})
export class OrdersModule {}
