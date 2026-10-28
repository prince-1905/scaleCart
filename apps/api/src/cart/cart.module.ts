import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { moduleTypeOrm } from '../database/module-typeorm.js';
import { CartController } from './cart.controller.js';
import { cartDatabase } from './cart.database.js';
import { CartService } from './cart.service.js';

@Module({
  imports: [...moduleTypeOrm(cartDatabase), CatalogModule],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
