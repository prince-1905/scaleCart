import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CatalogService } from '../catalog/catalog.service.js';
import type { StockLine } from '../inventory/inventory.service.js';
import { CartItem } from './cart-item.entity.js';

export const MAX_CART_LINES = 50;
export const MAX_QUANTITY_PER_LINE = 10;

/** The cart module's public API. */
@Injectable()
export class CartService {
  constructor(
    @InjectRepository(CartItem, 'cart') private readonly items: Repository<CartItem>,
    private readonly catalog: CatalogService,
  ) {}

  async getLines(userId: string): Promise<StockLine[]> {
    const rows = await this.items.find({ where: { userId }, order: { productId: 'ASC' } });
    return rows.map((r) => ({ productId: r.productId, quantity: r.quantity }));
  }

  /** The cart with *current* prices. Checkout prices it again: the client's numbers are never trusted. */
  async view(userId: string) {
    const lines = await this.getLines(userId);
    const products = await this.catalog.getByIds(lines.map((l) => l.productId));
    const items = lines
      .filter((l) => products.has(l.productId))
      .map((l) => {
        const p = products.get(l.productId)!;
        return {
          productId: l.productId,
          sku: p.sku,
          name: p.name,
          unitPriceCents: p.priceCents,
          quantity: l.quantity,
          lineTotalCents: p.priceCents * l.quantity,
        };
      });
    return { items, totalCents: items.reduce((sum, i) => sum + i.lineTotalCents, 0) };
  }

  /** Sets a line's quantity; 0 removes the line. */
  async setQuantity(userId: string, productId: number, quantity: number): Promise<void> {
    if (quantity === 0) {
      await this.items.delete({ userId, productId });
      return;
    }
    if (!(await this.catalog.getById(productId))) throw new NotFoundException('product not found');

    const lines = await this.items.countBy({ userId });
    const exists = await this.items.existsBy({ userId, productId });
    if (!exists && lines >= MAX_CART_LINES) {
      throw new BadRequestException(`a cart can hold at most ${MAX_CART_LINES} different products`);
    }
    await this.items.upsert({ userId, productId, quantity }, ['userId', 'productId']);
  }

  async clear(userId: string): Promise<void> {
    await this.items.delete({ userId });
  }

  /** Removes only the given products: something added during checkout stays in the cart. */
  async removeProducts(userId: string, productIds: number[]): Promise<void> {
    if (productIds.length === 0) return;
    await this.items.delete({ userId, productId: In(productIds) });
  }
}
