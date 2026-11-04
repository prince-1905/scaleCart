import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CatalogService } from '../catalog/catalog.service.js';
import { isDuplicateKey } from '../database/database.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { MetricsService } from '../observability/metrics.service.js';
import { Drop } from './drop.entities.js';
import { PREQUEUE_MS, WaitingRoom, type QueueStatus } from './waiting-room.js';

export interface DropView {
  id: number;
  name: string;
  status: 'upcoming' | 'live';
  startsAt: string;
  maxPerCustomer: number;
  admitPerSecond: number;
  /** Set = "one out, one in" with this many places; null = the line moves at admitPerSecond. */
  maxShoppers: number | null;
  product: { id: number; name: string; priceCents: number; category: string | null };
  available: number | null;
  /** The server's clock, so a countdown doesn't depend on the visitor's clock. */
  serverTime: string;
}

export interface NewDrop {
  productId: number;
  name?: string;
  startsAt: Date;
  maxPerCustomer: number;
  admitPerSecond: number;
  maxShoppers?: number | null;
}

/** One drop a checkout took part in, and the waiting-room ticket the buyer used. */
export interface DropClaim {
  dropId: number;
  ticket: number;
}

/** Checkout reads drops on every order: keep them in memory for a few seconds. */
const DROP_CACHE_MS = 5_000;

/**
 * Drops: scheduled flash sales. The rules are enforced here, on the server, at checkout:
 * a countdown in the browser is only a display.
 */
@Injectable()
export class DropsService {
  private cache?: { at: number; byProduct: Map<number, Drop> };

  constructor(
    @InjectDataSource('drops') private readonly db: DataSource,
    private readonly catalog: CatalogService,
    private readonly inventory: InventoryService,
    private readonly room: WaitingRoom,
    private readonly metrics: MetricsService,
  ) {}

  async create(input: NewDrop): Promise<DropView> {
    const product = await this.catalog.getById(input.productId);
    if (!product) throw new NotFoundException('product not found');
    try {
      const result = await this.db.getRepository(Drop).insert({
        productId: input.productId,
        name: input.name ?? product.name,
        startsAt: input.startsAt,
        maxPerCustomer: input.maxPerCustomer,
        admitPerSecond: input.admitPerSecond,
        maxShoppers: input.maxShoppers ?? null,
      });
      this.cache = undefined;
      return (await this.get(result.identifiers[0].id as number))!;
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictException('this product already has a drop');
      throw err;
    }
  }

  /** Drops that start in the future or started in the last 24 hours, soonest first. */
  async list(): Promise<DropView[]> {
    const drops = await this.db
      .getRepository(Drop)
      .createQueryBuilder('d')
      .where('d.startsAt > :since', { since: new Date(Date.now() - 24 * 3600_000) })
      .orderBy('d.startsAt', 'ASC')
      .limit(50)
      .getMany();
    return Promise.all(drops.map((d) => this.view(d)));
  }

  async get(id: number): Promise<DropView | null> {
    const drop = await this.db.getRepository(Drop).findOneBy({ id });
    return drop ? this.view(drop) : null;
  }

  /** Joins the waiting room (or reports the place already held). */
  async queue(dropId: number, userId: string): Promise<QueueStatus> {
    const drop = await this.db.getRepository(Drop).findOneBy({ id: dropId });
    if (!drop) throw new NotFoundException('drop not found');
    const opensAt = drop.startsAt.getTime() - PREQUEUE_MS;
    if (Date.now() < opensAt) {
      throw new ConflictException({
        statusCode: 409,
        error: 'queue_not_open',
        message: 'the line for this drop is not open yet',
        opensAt: new Date(opensAt).toISOString(),
      });
    }
    return this.room.join(drop, userId);
  }

  /**
   * Called by checkout, before any stock is taken. For every cart line that is a drop
   * product: the drop has started, the quantity is within the limit, the buyer holds a
   * valid pass, and this is their first purchase in the drop. The last one is an INSERT
   * into drop_purchases: the primary key lets one checkout per customer through.
   *
   * @returns the drops claimed for this order (with the buyer's ticket): give them back with
   *   releasePurchases() if checkout fails; free the buyer's place with freePlaces() when they're done.
   */
  async claimPurchases(
    userId: string,
    orderId: string,
    lines: { productId: number; quantity: number }[],
    pass: string | undefined,
  ): Promise<DropClaim[]> {
    const byProduct = await this.dropsByProduct();
    const claimed: DropClaim[] = [];
    const now = Date.now();
    try {
      for (const line of lines) {
        const drop = byProduct.get(line.productId);
        if (!drop) continue;
        if (line.quantity > drop.maxPerCustomer) {
          throw this.reject('drop_limit', 409, `at most ${drop.maxPerCustomer} per customer in "${drop.name}"`);
        }
        // A valid pass already proves the drop has started: passes are only issued after the
        // start. Checking the clock again here could contradict that: in E5 the server clock
        // jumped back by up to ~1 s every ~27 s, and 39 buyers holding passes were told
        // "not started". So the clock only decides what to tell someone WITHOUT a pass.
        const ticket = this.room.checkPass(pass, drop.id, userId, now);
        if (ticket === null) {
          if (now < drop.startsAt.getTime()) {
            throw this.reject('drop_not_started', 409, `"${drop.name}" goes on sale at ${drop.startsAt.toISOString()}`, {
              startsAt: drop.startsAt.toISOString(),
            });
          }
          throw this.reject('drop_pass_required', 403, `"${drop.name}" needs a waiting-room pass: join the line first`, {
            dropId: drop.id,
          });
        }
        await this.claim(drop, userId, orderId);
        claimed.push({ dropId: drop.id, ticket });
      }
      return claimed;
    } catch (err) {
      await this.releasePurchases(userId, orderId, claimed);
      throw err;
    }
  }

  /** Undo for claimPurchases(): the checkout failed, so these purchases didn't happen. */
  async releasePurchases(userId: string, orderId: string, claims: DropClaim[]): Promise<void> {
    if (claims.length === 0) return;
    const dropIds = claims.map((c) => c.dropId);
    await this.db.query('DELETE FROM drop_purchases WHERE user_id = ? AND order_id = ? AND drop_id IN (?)', [
      userId,
      orderId,
      dropIds,
    ]);
  }

  /** The buyer is done (bought, or sold out): their place at the counter goes to the next ticket. */
  async freePlaces(claims: DropClaim[]): Promise<void> {
    await Promise.all(claims.map((c) => this.room.release(c.dropId, c.ticket)));
  }

  private async claim(drop: Drop, userId: string, orderId: string) {
    try {
      await this.db.query('INSERT INTO drop_purchases (drop_id, user_id, order_id) VALUES (?, ?, ?)', [
        drop.id,
        userId,
        orderId,
      ]);
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // The same order claiming again (a retried checkout that took over its own key) is fine.
      const [row] = await this.db.query('SELECT order_id AS orderId FROM drop_purchases WHERE drop_id = ? AND user_id = ?', [
        drop.id,
        userId,
      ]);
      if (row?.orderId !== orderId) {
        throw this.reject('drop_already_bought', 409, `you already have an order in "${drop.name}"`);
      }
    }
  }

  private reject(error: string, status: 403 | 409, message: string, extra: object = {}) {
    this.metrics.dropCheckoutRejections.inc({ reason: error });
    const body = { statusCode: status, error, message, ...extra };
    return status === 403 ? new ForbiddenException(body) : new ConflictException(body);
  }

  private async dropsByProduct(): Promise<Map<number, Drop>> {
    if (this.cache && Date.now() - this.cache.at < DROP_CACHE_MS) return this.cache.byProduct;
    const drops = await this.db.getRepository(Drop).find();
    this.cache = { at: Date.now(), byProduct: new Map(drops.map((d) => [d.productId, d])) };
    return this.cache.byProduct;
  }

  private async view(d: Drop): Promise<DropView> {
    const [product, available] = await Promise.all([
      this.catalog.getById(d.productId),
      this.inventory.getAvailable(d.productId),
    ]);
    const now = new Date();
    return {
      id: d.id,
      name: d.name,
      status: now < d.startsAt ? 'upcoming' : 'live',
      startsAt: d.startsAt.toISOString(),
      maxPerCustomer: d.maxPerCustomer,
      admitPerSecond: d.admitPerSecond,
      maxShoppers: d.maxShoppers,
      product: product
        ? { id: product.id, name: product.name, priceCents: product.priceCents, category: product.category }
        : { id: d.productId, name: '(removed)', priceCents: 0, category: null },
      available,
      serverTime: now.toISOString(),
    };
  }
}
