import { Module } from '@nestjs/common';
import { moduleTypeOrm } from '../database/module-typeorm.js';
import { OrdersMaintenance } from './orders-maintenance.js';
import { ordersDatabase } from './orders.database.js';
import { OrdersService } from './orders.service.js';

/** Orders' data access without HTTP; used by the API (via OrdersModule) and the worker. */
@Module({
  imports: [...moduleTypeOrm(ordersDatabase)],
  providers: [OrdersService, OrdersMaintenance],
  exports: [OrdersService, OrdersMaintenance],
})
export class OrdersCoreModule {}
