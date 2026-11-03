import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { uuidv7 } from '../common/uuid.js';
import { ENV, type Env } from '../config/env.js';
import { isDuplicateKey } from '../database/database.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { MetricsService } from '../observability/metrics.service.js';
import { OrderLifecycle } from '../orders/order-lifecycle.js';
import type { OrderStatus } from '../orders/order.entity.js';
import {
  GatewayError,
  PAYMENT_GATEWAY,
  type GatewayPayment,
  type PaymentGateway,
} from './payment-gateway.js';
import type { PaymentAttempt, RefundReason } from './payment.entities.js';
import { verifyCheckoutSignature } from './signatures.js';

/** Don't open a payment for an order that's about to time out: the money could arrive after it's cancelled. */
const MIN_PAYMENT_WINDOW_SECONDS = 60;
const EXPIRE_BATCH = 100;
/** Leaves room inside the 30 s job interval. */
const EXPIRE_ROUND_MS = 20_000;

/** What the browser needs to open the provider's checkout for one order. */
export interface PaymentSession {
  orderId: string;
  provider: 'razorpay';
  keyId: string;
  providerOrderId: string;
  amountPaise: number;
  currency: string;
  /** The order is cancelled if not paid by then. */
  expiresAt: string;
}

/**
 * paid = this payment paid the order · duplicate = already applied (a repeat) ·
 * refund = money we must give back · failed = the attempt failed ·
 * ignored = nothing to do (not final yet) · unknown_order = not one of our provider orders
 */
export type PaymentOutcome = 'paid' | 'duplicate' | 'refund' | 'failed' | 'ignored' | 'unknown_order';

export type PaymentSource = 'webhook' | 'browser' | 'reconcile';

/**
 * Payments: open a payment for an order, and record what the provider reports.
 *
 * A payment's result can reach us three ways, in any order and any number of times:
 * the provider's webhook (the source of truth), the browser after checkout (faster, for
 * the UI), and the timeout job asking the provider (for lost webhooks). All three end in
 * applyPayment(), which is safe to repeat: the payment row is keyed by the provider's
 * payment id, and the order changes only through one conditional UPDATE.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectDataSource('payments') private readonly db: DataSource,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway | null,
    private readonly orders: OrderLifecycle,
    private readonly inventory: InventoryService,
    private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** "Pay" was clicked: create (or reuse) a provider order for this order. */
  async startPayment(userId: string, orderId: string): Promise<PaymentSession> {
    const gateway = this.requireGateway();
    const order = await this.orders.get(orderId);
    // Someone else's order looks exactly like a missing one.
    if (!order || order.userId !== userId) throw new NotFoundException('order not found');
    if (order.status !== 'pending_payment') {
      throw new ConflictException({ statusCode: 409, error: `order_${order.status}`, message: `order is ${order.status}` });
    }
    const expiresAt = new Date(order.createdAt.getTime() + this.env.paymentTimeoutSeconds * 1000);
    if (expiresAt.getTime() - Date.now() < MIN_PAYMENT_WINDOW_SECONDS * 1000) {
      throw new ConflictException({
        statusCode: 409,
        error: 'payment_window_closed',
        message: 'this order is about to expire; place a new order',
      });
    }

    const latest = await this.latestAttempt(orderId);
    // Reuse the last provider order unless a payment already failed on it (then Razorpay wants a new one).
    if (latest?.providerOrderId && !(await this.hasPayments(latest.id))) {
      return this.session(orderId, latest.providerOrderId, latest.amountPaise, latest.currency, expiresAt, gateway);
    }

    const attemptNo = (latest?.attemptNo ?? 0) + 1;
    const attemptId = uuidv7();
    try {
      // The INSERT is the lock: of two "Pay" clicks at the same moment, one creates attempt N.
      await this.db.query(
        `INSERT INTO payment_attempts (id, order_id, user_id, attempt_no, amount_paise, currency)
         VALUES (?, ?, ?, ?, ?, 'INR')`,
        [attemptId, orderId, userId, attemptNo, order.totalCents],
      );
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      throw new ConflictException('a payment for this order is being set up; retry in a moment');
    }

    let providerOrderId: string;
    try {
      const created = await gateway.createOrder({
        amountPaise: order.totalCents,
        // Max 40 characters, unique per attempt: the provider rejects a second order with the same receipt.
        receipt: `${orderId.replaceAll('-', '')}-${attemptNo}`,
        notes: { order_id: orderId, attempt: String(attemptNo) },
      });
      if (created.amountPaise !== order.totalCents) throw new GatewayError('provider changed the amount');
      providerOrderId = created.id;
    } catch (err) {
      await this.db.query('DELETE FROM payment_attempts WHERE id = ?', [attemptId]);
      this.count('start_failed', 'browser');
      this.logger.error(`could not create provider order for ${orderId}: ${(err as Error).message}`);
      throw new BadGatewayException({
        statusCode: 502,
        error: 'payment_provider_unavailable',
        message: 'the payment provider is not reachable; try again shortly',
      });
    }
    await this.db.query('UPDATE payment_attempts SET provider_order_id = ? WHERE id = ?', [providerOrderId, attemptId]);
    this.count('started', 'browser');
    return this.session(orderId, providerOrderId, order.totalCents, 'INR', expiresAt, gateway);
  }

  /**
   * The browser says "paid" (Razorpay Checkout's handler, or its redirect back to us).
   * Check its signature, then ask the provider for the real status: the browser only
   * makes the page update sooner.
   *
   * `userId` is null for the redirect callback, which arrives without our login token.
   * That's safe: only Razorpay can produce a valid signature for this provider order.
   */
  async confirmFromBrowser(
    userId: string | null,
    input: { providerOrderId: string; paymentId: string; signature: string },
  ): Promise<{ orderId: string; outcome: PaymentOutcome | 'processing'; orderStatus: OrderStatus }> {
    const gateway = this.requireGateway();
    const attempt = await this.attemptByProviderOrder(input.providerOrderId);
    if (!attempt || (userId !== null && attempt.userId !== userId)) throw new NotFoundException('payment not found');
    if (!verifyCheckoutSignature(attempt.providerOrderId!, input.paymentId, input.signature, this.env.razorpayKeySecret)) {
      this.count('bad_signature', 'browser');
      throw new BadRequestException('invalid payment signature');
    }

    let outcome: PaymentOutcome | 'processing';
    try {
      const payment = await gateway.fetchPayment(input.paymentId);
      if (payment.providerOrderId !== attempt.providerOrderId) throw new BadRequestException('payment is for another order');
      outcome = await this.applyPayment(payment, 'browser');
      if (outcome === 'ignored') outcome = 'processing'; // authorized, not captured yet: the webhook will finish it
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      // The provider's API is slow or down. The webhook (or the timeout job) will still settle it.
      this.logger.warn(`could not fetch payment ${input.paymentId}: ${err.message}`);
      outcome = 'processing';
    }
    const order = await this.orders.get(attempt.orderId);
    return { orderId: attempt.orderId, outcome, orderStatus: order!.status };
  }

  /** Records one payment the provider reported and moves the order accordingly. Safe to repeat. */
  async applyPayment(p: GatewayPayment, source: PaymentSource): Promise<PaymentOutcome> {
    const outcome = await this.apply(p);
    this.count(outcome, source);
    return outcome;
  }

  private async apply(p: GatewayPayment): Promise<PaymentOutcome> {
    const attempt = await this.attemptByProviderOrder(p.providerOrderId);
    if (!attempt) {
      // Not ours: e.g. another integration on the same Razorpay account. Acknowledge and move on.
      this.logger.warn(`payment ${p.id} is for unknown provider order ${p.providerOrderId}`);
      return 'unknown_order';
    }
    if (p.status === 'failed') {
      await this.db.query(
        `INSERT INTO payments (id, attempt_id, order_id, amount_paise, currency, status, error_code, error_description)
         VALUES (?, ?, ?, ?, ?, 'failed', ?, ?)
           ON DUPLICATE KEY UPDATE id = payments.id`,
        [p.id, attempt.id, attempt.orderId, p.amountPaise, p.currency, p.errorCode, p.errorDescription?.slice(0, 255) ?? null],
      );
      return 'failed';
    }
    // created / authorized: not money yet (auto-capture follows). refunded: nothing for us to do.
    if (p.status !== 'captured') return 'ignored';

    // Insert, or upgrade a row we saw as failed; never downgrade (events can arrive out of order).
    await this.db.query(
      `INSERT INTO payments (id, attempt_id, order_id, amount_paise, currency, status)
       VALUES (?, ?, ?, ?, ?, 'captured')
         ON DUPLICATE KEY UPDATE status = IF(payments.status = 'failed', 'captured', payments.status)`,
      [p.id, attempt.id, attempt.orderId, p.amountPaise, p.currency],
    );

    if (p.amountPaise !== attempt.amountPaise || p.currency !== attempt.currency) {
      this.logger.error(
        `payment ${p.id} took ${p.amountPaise} ${p.currency}, expected ${attempt.amountPaise} ${attempt.currency}`,
      );
      return this.refundLater(p.id, 'amount_mismatch');
    }

    // The order row decides whether this is new: exactly one caller ever gets 'paid'.
    switch (await this.orders.markPaid(attempt.orderId, p.id)) {
      case 'paid':
        await this.inventory.commit(attempt.orderId);
        return 'paid';
      case 'already_paid':
        // A repeat. Commit again anyway: if the first run crashed before committing, this finishes it.
        await this.inventory.commit(attempt.orderId);
        return 'duplicate';
      case 'paid_by_other':
        return this.refundLater(p.id, 'paid_twice');
      case 'cancelled':
      case 'not_found':
        return this.refundLater(p.id, 'order_cancelled');
    }
  }

  /**
   * The payment-timeout job. For each unpaid order past its deadline: first ask the
   * provider whether it was paid after all (a webhook may have been lost), then cancel
   * it and give its stock back. If the provider can't be reached, the order is left for
   * the next run: never cancel what we couldn't check.
   */
  async expireOverdueOrders(): Promise<{ paid: number; cancelled: number; skipped: number }> {
    const result = { paid: 0, cancelled: 0, skipped: 0 };
    const started = Date.now();
    // Batches of 100 until none are left. One batch per round drained only ~200 orders/min,
    // so 40k abandoned load-test orders would have taken hours (found in the first live run).
    // Stop early when a batch changed nothing (e.g. the provider is down: the same orders
    // would come back first every time) or the round has used its time budget.
    for (;;) {
      const batch = await this.orders.overdue(this.env.paymentTimeoutSeconds, EXPIRE_BATCH);
      const before = result.paid + result.cancelled;
      await this.expireBatch(batch, result);
      const progressed = result.paid + result.cancelled > before;
      if (batch.length < EXPIRE_BATCH || !progressed || Date.now() - started > EXPIRE_ROUND_MS) break;
    }
    if (result.paid) this.logger.warn(`found ${result.paid} paid order(s) whose webhook never arrived`);
    if (result.cancelled) {
      this.logger.log(`expired ${result.cancelled} unpaid order(s) in ${Date.now() - started} ms`);
    }
    this.metrics.paymentJobs.inc({ job: 'expired_orders' }, result.cancelled);
    this.metrics.paymentJobs.inc({ job: 'reconciled_paid' }, result.paid);
    return result;
  }

  private async expireBatch(orderIds: string[], result: { paid: number; cancelled: number; skipped: number }) {
    for (const orderId of orderIds) {
      const attempts: { providerOrderId: string }[] = await this.db.query(
        `SELECT provider_order_id AS providerOrderId FROM payment_attempts
          WHERE order_id = ? AND provider_order_id IS NOT NULL`,
        [orderId],
      );
      try {
        for (const a of attempts) {
          if (!this.gateway) throw new GatewayError('payments are not configured');
          for (const p of await this.gateway.fetchOrderPayments(a.providerOrderId)) {
            if ((await this.applyPayment(p, 'reconcile')) === 'paid') result.paid++;
          }
        }
      } catch (err) {
        if (!(err instanceof GatewayError)) throw err;
        this.logger.warn(`could not check payments of overdue order ${orderId}: ${err.message}`);
        result.skipped++;
        continue;
      }
      if (await this.orders.cancelIfUnpaid(orderId)) {
        await this.inventory.release(orderId);
        result.cancelled++;
      }
    }
  }

  /**
   * Gives back money we must not keep. Runs in the worker, not in the webhook: the
   * webhook must answer within 5 s, and a refund call to the provider can be slow or fail.
   * The receipt makes a repeat (two workers, or a crash after the call) harmless.
   */
  async sendPendingRefunds(limit = 20): Promise<{ refunded: number; failed: number }> {
    const result = { refunded: 0, failed: 0 };
    if (!this.gateway) return result;
    const rows: { id: string }[] = await this.db.query(
      `SELECT id FROM payments WHERE status = 'refund_pending' ORDER BY updated_at LIMIT ?`,
      [limit],
    );
    for (const { id } of rows) {
      try {
        const refund = await this.gateway.refund(id, `rf_${id}`);
        await this.db.query(
          `UPDATE payments SET status = 'refunded', refund_id = COALESCE(?, refund_id)
            WHERE id = ? AND status = 'refund_pending'`,
          [refund.refundId, id],
        );
        result.refunded++;
      } catch (err) {
        this.logger.error(`refund of ${id} failed (will retry): ${(err as Error).message}`);
        result.failed++;
      }
    }
    this.metrics.paymentJobs.inc({ job: 'refunds_sent' }, result.refunded);
    this.metrics.paymentJobs.inc({ job: 'refunds_failed' }, result.failed);
    return result;
  }

  private async refundLater(paymentId: string, reason: RefundReason): Promise<PaymentOutcome> {
    await this.db.query(
      `UPDATE payments SET status = 'refund_pending', refund_reason = ? WHERE id = ? AND status = 'captured'`,
      [reason, paymentId],
    );
    this.logger.warn(`payment ${paymentId} will be refunded: ${reason}`);
    return 'refund';
  }

  private requireGateway(): PaymentGateway {
    if (!this.gateway) throw new ServiceUnavailableException('payments are not configured (RAZORPAY_KEY_ID)');
    return this.gateway;
  }

  private session(
    orderId: string,
    providerOrderId: string,
    amountPaise: number,
    currency: string,
    expiresAt: Date,
    gateway: PaymentGateway,
  ): PaymentSession {
    return {
      orderId,
      provider: gateway.provider,
      keyId: gateway.publicKey,
      providerOrderId,
      amountPaise,
      currency,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async latestAttempt(orderId: string): Promise<PaymentAttempt | null> {
    const [row] = await this.db.query(
      `SELECT id, order_id AS orderId, user_id AS userId, attempt_no AS attemptNo,
              provider_order_id AS providerOrderId, amount_paise AS amountPaise, currency
         FROM payment_attempts WHERE order_id = ? ORDER BY attempt_no DESC LIMIT 1`,
      [orderId],
    );
    return row ?? null;
  }

  private async attemptByProviderOrder(providerOrderId: string): Promise<PaymentAttempt | null> {
    const [row] = await this.db.query(
      `SELECT id, order_id AS orderId, user_id AS userId, attempt_no AS attemptNo,
              provider_order_id AS providerOrderId, amount_paise AS amountPaise, currency
         FROM payment_attempts WHERE provider_order_id = ?`,
      [providerOrderId],
    );
    return row ?? null;
  }

  private async hasPayments(attemptId: string): Promise<boolean> {
    const rows = await this.db.query('SELECT 1 FROM payments WHERE attempt_id = ? LIMIT 1', [attemptId]);
    return rows.length > 0;
  }

  private count(outcome: string, source: PaymentSource) {
    this.metrics.payments.inc({ outcome, source });
  }
}
