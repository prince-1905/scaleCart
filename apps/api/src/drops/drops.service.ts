import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CatalogService } from '../catalog/catalog.service.js';
import { isDuplicateKey } from '../database/database.js';
import { ENV, type Env } from '../config/env.js';
import { InventoryService, OutOfStockError } from '../inventory/inventory.service.js';
import { MetricsService } from '../observability/metrics.service.js';
import { Drop } from './drop.entities.js';
import { StockGate } from './stock-gate.js';
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

/** What an admin may change on a drop. */
export interface DropChanges {
  name?: string;
  startsAt?: Date;
  maxPerCustomer?: number;
  admitPerSecond?: number;
  maxShoppers?: number | null;
}

/** One drop a checkout took part in, and the waiting-room ticket the buyer used. */
export interface DropClaim {
  dropId: number;
  ticket: number;
  productId: number;
  quantity: number;
}

/** Checkout reads drops on every order: keep them in memory for a few seconds. */
const DROP_CACHE_MS = 5_000;
/** How long "join the line" trusts a MySQL stock reading when there is no Redis counter. */
const STOCK_CACHE_MS = 2_000;

/**
 * Drops: scheduled flash sales. The rules are enforced here, on the server, at checkout:
 * a countdown in the browser is only a display.
 */
@Injectable()
export class DropsService {
  private cache?: { at: number; byProduct: Map<number, Drop> };
  private readonly stockCache = new Map<number, { at: number; available: number }>();

  constructor(
    @InjectDataSource('drops') private readonly db: DataSource,
    private readonly catalog: CatalogService,
    private readonly inventory: InventoryService,
    private readonly room: WaitingRoom,
    private readonly gate: StockGate,
    private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: Env,
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

  /** Admin: change a drop's timing or limits. The in-memory lists of every replica catch up within 5 s. */
  async update(id: number, changes: DropChanges): Promise<DropView> {
    const drop = await this.db.getRepository(Drop).findOneBy({ id });
    if (!drop) throw new NotFoundException('drop not found');
    const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length > 0) await this.db.getRepository(Drop).update({ id }, set);
    this.cache = undefined;
    return (await this.get(id))!;
  }

  /** Admin: cancel a drop, only while nobody has bought in it (orders already placed would lose their drop). */
  async remove(id: number): Promise<void> {
    const [{ purchases }] = await this.db.query('SELECT COUNT(*) AS purchases FROM drop_purchases WHERE drop_id = ?', [id]);
    if (Number(purchases) > 0) {
      throw new ConflictException({ statusCode: 409, error: 'drop_has_orders', message: 'customers already have orders in this drop' });
    }
    const result = await this.db.getRepository(Drop).delete({ id });
    if (!result.affected) throw new NotFoundException('drop not found');
    this.cache = undefined;
  }

  /** Admin's live monitor: the line (Redis), purchases (MySQL), stock and the door counter. */
  async stats(id: number) {
    const drop = await this.db.getRepository(Drop).findOneBy({ id });
    if (!drop) throw new NotFoundException('drop not found');
    const [line, [{ purchases }], available, gateCounter] = await Promise.all([
      this.room.lineStats(drop),
      this.db.query('SELECT COUNT(*) AS purchases FROM drop_purchases WHERE drop_id = ?', [id]),
      this.inventory.getAvailable(drop.productId),
      this.gate.peek(id),
    ]);
    return {
      dropId: id,
      ...line,
      inLine: line.ticketsIssued === null || line.calledUpTo === null ? null : Math.max(0, line.ticketsIssued - line.calledUpTo),
      purchases: Number(purchases),
      available,
      gateCounter: gateCounter ?? null,
      serverTime: new Date().toISOString(),
    };
  }

  /** Joins the waiting room (or reports the place already held). Staff can't: limited stock is for customers. */
  async queue(dropId: number, userId: string, role: 'customer' | 'admin' = 'customer'): Promise<QueueStatus> {
    if (role === 'admin') {
      throw new ForbiddenException({ statusCode: 403, error: 'staff_cannot_join_drops', message: 'staff accounts cannot join drops' });
    }
    // From the 5 s in-memory list: every buyer repeats this call every few seconds (E7c: reading
    // MySQL here on every call timed out under load).
    const drop =
      [...(await this.dropsByProduct()).values()].find((d) => d.id === dropId) ??
      (await this.db.getRepository(Drop).findOneBy({ id: dropId }));
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
    // Sold out: no ticket, no "your turn" that can only end in "sold out". The line resumes by itself
    // if stock comes back (an unpaid order expires and the counter is reset from MySQL).
    if (await this.soldOut(drop)) {
      return { dropId, ticket: 0, admittedUpTo: 0, position: 0, etaSeconds: 0, admitted: false, soldOut: true };
    }
    return this.room.join(drop, userId);
  }

  /**
   * Is there nothing left to try for? The Redis door counter answers without MySQL. Without one (gate off,
   * Redis down, or no checkout yet), MySQL's stock, remembered for 2 s per drop.
   */
  private async soldOut(drop: Drop): Promise<boolean> {
    const counter = this.env.dropStockGate ? await this.gate.peek(drop.id) : undefined;
    if (counter !== undefined) return counter <= 0;
    const cached = this.stockCache.get(drop.id);
    if (cached && Date.now() - cached.at < STOCK_CACHE_MS) return cached.available <= 0;
    const available = (await this.inventory.getAvailable(drop.productId)) ?? 0;
    this.stockCache.set(drop.id, { at: Date.now(), available });
    return available <= 0;
  }

  /**
   * Step 1 of a drop checkout, with no database writes: for every cart line that is a drop
   * product, the quantity is within the limit and the buyer holds a valid pass (or, without
   * one, we tell them whether the drop hasn't started or they must queue). Checkout calls
   * this first, then the Redis door counter, and only then writes anything.
   *
   * @returns the buyer's drop lines (with their ticket), for takeFromGate() and claimPurchases().
   */
  async checkRules(
    userId: string,
    lines: { productId: number; quantity: number }[],
    pass: string | undefined,
  ): Promise<DropClaim[]> {
    const byProduct = await this.dropsByProduct();
    const result: DropClaim[] = [];
    const now = Date.now();
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
      result.push({ dropId: drop.id, ticket, productId: line.productId, quantity: line.quantity });
    }
    return result;
  }

  /**
   * Step 3: "this is their first purchase in the drop", an INSERT into drop_purchases whose
   * primary key lets one checkout per customer through. All or nothing over the lines.
   * Give them back with releasePurchases() if checkout fails later.
   */
  async claimPurchases(userId: string, orderId: string, claims: DropClaim[]): Promise<void> {
    if (claims.length === 0) return;
    const byProduct = await this.dropsByProduct();
    const done: DropClaim[] = [];
    try {
      for (const c of claims) {
        await this.claim(byProduct.get(c.productId)!, userId, orderId);
        done.push(c);
      }
    } catch (err) {
      await this.releasePurchases(userId, orderId, done);
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

  /**
   * The door counter (Redis) for each drop line, before checkout touches the MySQL stock row.
   * Throws OutOfStockError when a drop's counter is at 0: that buyer never queues for the row lock.
   * @returns the lines the gate let through: hand them to returnToGate() if checkout fails later.
   */
  async takeFromGate(claims: DropClaim[]): Promise<DropClaim[]> {
    if (!this.env.dropStockGate) return [];
    const taken: DropClaim[] = [];
    for (const c of claims) {
      const answer = await this.gate.take(c.dropId, c.quantity, async () => (await this.inventory.getAvailable(c.productId)) ?? 0);
      if (answer === 'sold_out') {
        await this.returnToGate(taken);
        throw new OutOfStockError(c.productId);
      }
      // 'unavailable' (Redis down): go on to MySQL, which decides anyway.
      if (answer === 'taken') taken.push(c);
    }
    return taken;
  }

  /** Undo for takeFromGate(): checkout failed after the gate, so those units are back on the shelf. */
  async returnToGate(taken: DropClaim[]): Promise<void> {
    await Promise.all(taken.map((c) => this.gate.giveBack(c.dropId, c.quantity)));
  }

  /**
   * Sets every live drop's door counter to MySQL's real stock. Catches drift: orders that
   * expired unpaid (their stock went back in MySQL), admin stock changes, a counter that a
   * crashed request never gave back. Runs every few seconds on each API replica; repeating it is harmless.
   */
  async resetGates(): Promise<number> {
    if (!this.env.dropStockGate) return 0;
    const live = await this.db
      .getRepository(Drop)
      .createQueryBuilder('d')
      .where('d.startsAt BETWEEN :from AND :to', {
        from: new Date(Date.now() - 24 * 3600_000),
        to: new Date(Date.now() + PREQUEUE_MS),
      })
      .getMany();
    for (const d of live) await this.gate.reset(d.id, (await this.inventory.getAvailable(d.productId)) ?? 0);
    return live.length;
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
