import { Injectable, Module } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { moduleTypeOrm } from '../database/module-typeorm.js';
import { dropsDatabase } from './drops.database.js';

/**
 * The "one purchase per customer" records, for other modules. When an unpaid order is cancelled
 * (payment timeout), the customer didn't buy, so their record goes and they may try the drop again.
 * Without this, one abandoned payment locked a customer out of the drop for good.
 */
@Injectable()
export class DropPurchases {
  constructor(@InjectDataSource('drops') private readonly db: DataSource) {}

  async releaseOrder(orderId: string): Promise<number> {
    const result: { affectedRows: number } = await this.db.query('DELETE FROM drop_purchases WHERE order_id = ?', [orderId]);
    return result.affectedRows;
  }
}

/**
 * The drops database plus DropPurchases, without the rest of the drops module (no catalog, no Redis):
 * light enough for the worker, whose payment-timeout job cancels orders.
 */
@Module({
  imports: [...moduleTypeOrm(dropsDatabase)],
  providers: [DropPurchases],
  exports: [DropPurchases],
})
export class DropsDataModule {}
