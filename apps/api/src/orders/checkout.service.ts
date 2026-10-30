import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CartService } from '../cart/cart.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { uuidv7 } from '../common/uuid.js';
import { ENV, type Env, type NotifyMode } from '../config/env.js';
import { isDuplicateKey, type WriteResult } from '../database/database.js';
import { UserDirectory } from '../identity/user-directory.js';
import { InventoryService, OutOfStockError } from '../inventory/inventory.service.js';
import { MailerService } from '../notifications/mailer.service.js';
import { MetricsService } from '../observability/metrics.service.js';
import type { CheckoutDto } from './checkout.dto.js';
import { ORDER_CREATED, type OrderCreatedEvent } from './events.js';
import { IdempotencyKey } from './idempotency-key.entity.js';
import { Order, OrderItem, type OrderStatus } from './order.entity.js';
import { OutboxEvent } from './outbox.entity.js';

export interface OrderView {
  id: string;
  status: OrderStatus;
  totalCents: number;
  items: { productId: number; sku: string; name: string; unitPriceCents: number; quantity: number }[];
  createdAt: string;
}

export interface CheckoutResult {
  /** True when this is a stored answer to an earlier request with the same key. */
  replayed: boolean;
  order: OrderView;
}

/**
 * An in-progress claim older than this is treated as abandoned (its request crashed)
 * and may be taken over. Matches the load balancer's 30 s timeout: a request still
 * running after that has already been given up on by the client.
 */
const STALE_CLAIM_SECONDS = 30;

type Claim =
  | { kind: 'claimed'; orderId: string }
  | { kind: 'replay'; order: OrderView }
  | { kind: 'in_progress' }
  | { kind: 'mismatch' };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Checkout = turn the cart into an order without overselling or double-charging.
 *
 *   1. Claim the Idempotency-Key (INSERT; the primary key lets only one request win).
 *   2. Price the cart from the catalog (never trust client prices).
 *   3. Reserve stock in the inventory module (atomic conditional UPDATE).
 *   4. In ONE orders-database transaction: insert the order, its lines, the
 *      "order.created" event (outbox) and the stored response for the key.
 *      Either all of it exists or none of it.
 *   5. If step 4 fails, release the stock from step 3 (compensation).
 *
 * Steps 3 and 4 touch different modules' databases, so no single transaction can
 * cover both. That gap is closed by compensation now, and by a reservation
 * expiry sweeper / saga in Phases 3-4.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  private readonly notifyMode: NotifyMode;

  constructor(
    @InjectDataSource('orders') private readonly db: DataSource,
    private readonly cart: CartService,
    private readonly catalog: CatalogService,
    private readonly inventory: InventoryService,
    private readonly metrics: MetricsService,
    private readonly users: UserDirectory,
    private readonly mailer: MailerService,
    @Inject(ENV) env: Env,
  ) {
    this.notifyMode = env.notifyMode;
  }

  async checkout(userId: string, key: string, dto: CheckoutDto): Promise<CheckoutResult> {
    const claim = await this.claim(userId, key, sha256(JSON.stringify(dto)));
    switch (claim.kind) {
      case 'replay':
        this.count('replayed');
        return { replayed: true, order: claim.order };
      case 'in_progress':
        this.count('in_progress');
        throw new ConflictException(
          'a checkout with this Idempotency-Key is still being processed; retry shortly',
        );
      case 'mismatch':
        this.count('key_reused');
        throw new UnprocessableEntityException(
          'this Idempotency-Key was already used for a different request',
        );
    }

    let order: OrderView;
    try {
      order = await this.placeOrder(userId, key, claim.orderId, dto);
    } catch (err) {
      // Free the key: nothing was sold, so the client may retry with the same key.
      await this.releaseClaim(userId, key).catch((e) =>
        this.logger.error({ err: e, userId, key }, 'could not release idempotency claim'),
      );
      if (err instanceof OutOfStockError) {
        this.count('out_of_stock');
        throw new ConflictException({
          statusCode: 409,
          error: 'out_of_stock',
          message: err.message,
          productId: err.productId,
        });
      }
      this.count(err instanceof HttpException ? 'rejected' : 'error');
      throw err;
    }

    this.count('created');
    // After the order is safe. If this fails, a leftover cart line is harmless.
    await this.cart
      .removeProducts(userId, order.items.map((i) => i.productId))
      .catch((err) => this.logger.warn({ err, userId }, 'could not clear purchased cart lines'));
    return { replayed: false, order };
  }

  private async placeOrder(
    userId: string,
    key: string,
    orderId: string,
    dto: CheckoutDto,
  ): Promise<OrderView> {
    const lines = await this.cart.getLines(userId);
    if (lines.length === 0) throw new BadRequestException('cart is empty');

    const products = await this.catalog.getByIds(lines.map((l) => l.productId));
    const items = lines.map((l) => {
      const p = products.get(l.productId);
      if (!p) throw new ConflictException(`product ${l.productId} is no longer sold`);
      return {
        productId: p.id,
        sku: p.sku,
        name: p.name,
        unitPriceCents: p.priceCents,
        quantity: l.quantity,
      };
    });
    const totalCents = items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
    if (dto.expectedTotalCents !== undefined && dto.expectedTotalCents !== totalCents) {
      throw new ConflictException({
        statusCode: 409,
        error: 'price_changed',
        message: 'the cart total changed since it was shown; review the cart and retry',
        totalCents,
      });
    }

    await this.inventory.reserve(orderId, lines);

    const order: OrderView = {
      id: orderId,
      status: 'pending_payment',
      totalCents,
      items,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.db.transaction(async (m) => {
        await m.insert(Order, { id: orderId, userId, status: order.status, totalCents });
        await m.insert(
          OrderItem,
          items.map((i) => ({ orderId, ...i })),
        );
        if (this.notifyMode === 'outbox') {
          // Same transaction as the order: the event exists if and only if the order does.
          const event: OrderCreatedEvent = {
            schemaVersion: 1,
            eventId: uuidv7(),
            occurredAt: order.createdAt,
            orderId,
            userId,
            totalCents,
            items: items.map(({ productId, name, unitPriceCents, quantity }) => ({
              productId,
              name,
              unitPriceCents,
              quantity,
            })),
          };
          await m.insert(OutboxEvent, {
            id: event.eventId,
            eventType: ORDER_CREATED,
            aggregateId: orderId,
            payload: event,
          });
        }
        const done = await m.update(
          IdempotencyKey,
          { userId, key, status: 'in_progress' },
          { status: 'completed', responseBody: order },
        );
        if (done.affected !== 1) throw new Error('lost the idempotency claim during checkout');
      });
    } catch (err) {
      // A duplicate order id means another attempt with this key already created the
      // order; its stock must stay reserved. Otherwise undo the reservation.
      if (!isDuplicateKey(err)) {
        await this.inventory.release(orderId).catch((e) =>
          this.logger.error({ err: e, orderId }, 'COMPENSATION FAILED: stock stays reserved'),
        );
      }
      throw err;
    }

    if (this.notifyMode === 'sync') {
      // LAB ONLY (experiment E3): the "obvious" way. The customer waits for the mail
      // server, and if it fails, they get an error for an order that WAS created and
      // will never get its email: two systems written without a shared transaction.
      const to = await this.users.getEmail(userId);
      if (to) await this.mailer.sendOrderConfirmation({ to, orderId, totalCents, items });
    }
    return order;
  }

  /**
   * Claims the key for this request, or explains why not. The INSERT is the lock:
   * of two identical requests arriving together, the primary key lets one through.
   * Timestamps come from the database clock (NOW) so app servers' clocks don't matter.
   */
  private async claim(userId: string, key: string, requestHash: string): Promise<Claim> {
    const orderId = uuidv7();
    try {
      await this.db.query(
        `INSERT INTO idempotency_keys (user_id, idem_key, request_hash, order_id, status, claimed_at)
         VALUES (?, ?, ?, ?, 'in_progress', NOW(3))`,
        [userId, key, requestHash, orderId],
      );
      return { kind: 'claimed', orderId };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }

    const existing = await this.db.getRepository(IdempotencyKey).findOneBy({ userId, key });
    // Gone already: the first request just failed and released it. Retrying is safe.
    if (!existing) return { kind: 'in_progress' };
    if (existing.requestHash !== requestHash) return { kind: 'mismatch' };
    if (existing.status === 'completed') return { kind: 'replay', order: existing.responseBody as OrderView };

    // Still in progress. Take it over only if it looks abandoned; reusing its order id
    // makes the inventory reservation (keyed by order id) a no-op if it already happened.
    const takeover: WriteResult = await this.db.query(
      `UPDATE idempotency_keys SET claimed_at = NOW(3)
        WHERE user_id = ? AND idem_key = ? AND status = 'in_progress'
          AND claimed_at < NOW(3) - INTERVAL ${STALE_CLAIM_SECONDS} SECOND`,
      [userId, key],
    );
    return takeover.affectedRows === 1
      ? { kind: 'claimed', orderId: existing.orderId }
      : { kind: 'in_progress' };
  }

  private async releaseClaim(userId: string, key: string) {
    await this.db
      .getRepository(IdempotencyKey)
      .delete({ userId, key, status: 'in_progress' });
  }

  private count(outcome: string) {
    this.metrics.checkouts.inc({ outcome });
  }
}
