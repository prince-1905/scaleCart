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
import { DataSource, type EntityManager } from 'typeorm';
import { uuidv7 } from '../common/uuid.js';
import { ENV, type PaymentsEnv } from '../config/env.js';
import { isDuplicateKey, retryOnDeadlock, type WriteResult } from '../database/database.js';
import { EVENTS, type OrderPaymentResultEvent, type PaymentCapturedEvent } from '../messaging/topology.js';
import { MetricsService } from '../observability/metrics.service.js';
import { ShopClient } from '../shop/shop-client.js';
import { GatewayError, PAYMENT_GATEWAY, type GatewayPayment, type PaymentGateway } from './payment-gateway.js';
import type { PaymentAttempt, RefundReason } from './payment.entities.js';
import { verifyCheckoutSignature } from './signatures.js';

/** Don't open a payment for an order that's about to time out: the money could arrive after it's cancelled. */
const MIN_PAYMENT_WINDOW_SECONDS = 60;

export interface PaymentSession {
  orderId: string;
  provider: 'razorpay';
  keyId: string;
  providerOrderId: string;
  amountPaise: number;
  currency: string;
  expiresAt: string;
}

/**
 * captured  = new money: payment.captured is on its way to the shop, which decides paid vs refund
 * duplicate = already recorded (a repeat) · refund = we must give it back (wrong amount)
 * failed = the attempt failed · ignored = not final yet · unknown_order = not one of our provider orders
 */
export type PaymentOutcome = 'captured' | 'duplicate' | 'refund' | 'failed' | 'ignored' | 'unknown_order';
export type PaymentSource = 'webhook' | 'browser' | 'reconcile';

/**
 * The payments service's core. Compared with the monolith version:
 * - the order (amount, owner, status, deadline) comes from the shop over HTTP (ShopClient), only to start a payment;
 * - "this payment is captured" is an EVENT, written to the outbox in the same transaction as the payment row.
 *   The shop marks the order paid and answers with order.payment_result; paid_by_other / cancelled → refund.
 * So a webhook is accepted and stored even while the shop is down: the order catches up when it's back.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway | null,
    private readonly shop: ShopClient,
    private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: PaymentsEnv,
  ) {}

  /** "Pay" was clicked: create (or reuse) a provider order for this order. `requestId`: the gateway's X-Request-ID,
   *  passed on to the shop so both services log the same id. */
  async startPayment(userId: string, orderId: string, requestId?: string): Promise<PaymentSession> {
    const gateway = this.requireGateway();
    const order = await this.shop.getOrder(orderId, requestId);
    if (!order || order.userId !== userId) throw new NotFoundException('order not found');
    if (order.status !== 'pending_payment') {
      throw new ConflictException({ statusCode: 409, error: `order_${order.status}`, message: `order is ${order.status}` });
    }
    const expiresAt = new Date(order.payBy);
    if (expiresAt.getTime() - Date.now() < MIN_PAYMENT_WINDOW_SECONDS * 1000) {
      throw new ConflictException({
        statusCode: 409,
        error: 'payment_window_closed',
        message: 'this order is about to expire; place a new order',
      });
    }

    const latest = await this.latestAttempt(orderId);
    if (latest?.providerOrderId && !(await this.hasPayments(latest.id))) {
      return this.session(orderId, latest.providerOrderId, latest.amountPaise, latest.currency, expiresAt, gateway);
    }

    const attemptNo = (latest?.attemptNo ?? 0) + 1;
    const attemptId = uuidv7();
    try {
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
   * The browser says "paid". Check the signature, ask the provider for the real status, record it. The order itself
   * is settled by the shop when the event arrives, usually within a second: the page shows "confirming" and polls.
   */
  async confirmFromBrowser(
    userId: string | null,
    input: { providerOrderId: string; paymentId: string; signature: string },
  ): Promise<{ orderId: string; outcome: PaymentOutcome | 'processing' }> {
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
      // Recorded; the shop confirms the order asynchronously.
      if (outcome === 'captured' || outcome === 'duplicate' || outcome === 'ignored') outcome = 'processing';
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      this.logger.warn(`could not fetch payment ${input.paymentId}: ${err.message}`);
      outcome = 'processing';
    }
    return { orderId: attempt.orderId, outcome };
  }

  /** Records one payment the provider reported. Safe to repeat: the payment row is keyed by the provider's id. */
  async applyPayment(p: GatewayPayment, source: PaymentSource): Promise<PaymentOutcome> {
    const outcome = await this.apply(p);
    this.count(outcome, source);
    return outcome;
  }

  private async apply(p: GatewayPayment): Promise<PaymentOutcome> {
    const attempt = await this.attemptByProviderOrder(p.providerOrderId);
    if (!attempt) {
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
    if (p.status !== 'captured') return 'ignored';

    const wrongAmount = p.amountPaise !== attempt.amountPaise || p.currency !== attempt.currency;
    // One transaction: the payment row AND (for new money) the event to the shop. Either both or neither.
    // A deadlock victim's transaction is rolled back whole, so running it again is safe (it then sees the row).
    return retryOnDeadlock(() => this.db.transaction(async (m) => {
      // New money = the row is inserted now, or a row we saw as 'failed' becomes 'captured' (events arrive out of
      // order). Not ON DUPLICATE KEY UPDATE's affectedRows: mysql2 sets CLIENT_FOUND_ROWS, so "already captured,
      // nothing changed" also counts 1 there, and a repeat would look new.
      try {
        await m.query(
          `INSERT INTO payments (id, attempt_id, order_id, amount_paise, currency, status) VALUES (?, ?, ?, ?, ?, 'captured')`,
          [p.id, attempt.id, attempt.orderId, p.amountPaise, p.currency],
        );
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        // A parallel copy waited on the row lock and got "duplicate": it now holds a SHARED lock on the row. Read
        // first; only a 'failed' row needs the UPDATE (an exclusive lock). Updating straight away made two such
        // copies wait for each other's shared lock: a deadlock, answered 500 (found by the 20-at-once test).
        const [row] = await m.query('SELECT status FROM payments WHERE id = ? FOR SHARE', [p.id]);
        if (row?.status !== 'failed') return 'duplicate';
        const upgraded: WriteResult = await m.query(
          `UPDATE payments SET status = 'captured' WHERE id = ? AND status = 'failed'`,
          [p.id],
        );
        if (upgraded.affectedRows === 0) return 'duplicate';
      }

      if (wrongAmount) {
        this.logger.error(`payment ${p.id} took ${p.amountPaise} ${p.currency}, expected ${attempt.amountPaise} ${attempt.currency}`);
        return this.refundLater(m, p.id, 'amount_mismatch');
      }
      const event: PaymentCapturedEvent = { orderId: attempt.orderId, paymentId: p.id, amountPaise: p.amountPaise };
      await m.query('INSERT INTO outbox (id, event_type, aggregate_id, payload) VALUES (?, ?, ?, ?)', [
        uuidv7(),
        EVENTS.paymentCaptured,
        attempt.orderId,
        JSON.stringify(event),
      ]);
      return 'captured';
    }));
  }

  /**
   * The shop's answer to payment.captured. paid / already_paid: nothing to do. paid_by_other (the order was paid by
   * another payment) or cancelled (it timed out first): this money must go back. Repeats are harmless: refundLater
   * only changes a 'captured' row, and the caller skips event ids it has seen.
   */
  async onOrderPaymentResult(event: OrderPaymentResultEvent, m: EntityManager = this.db.manager): Promise<void> {
    if (event.result === 'paid' || event.result === 'already_paid') return;
    const reason: RefundReason = event.result === 'paid_by_other' ? 'paid_twice' : 'order_cancelled';
    await this.refundLater(m, event.paymentId, reason);
  }

  /**
   * Asked by the shop's expiry job before it cancels an unpaid order: "was it paid after all?" Checks with the
   * provider (a webhook may have been lost) and records what it finds. `paid: true` = keep the order: a
   * payment.captured event is (or already was) on its way. Throws 502 if the provider can't be asked, and then the
   * shop must not cancel (never cancel what we couldn't check).
   */
  async reconcileOrder(orderId: string): Promise<{ paid: boolean }> {
    const attempts: { providerOrderId: string }[] = await this.db.query(
      `SELECT provider_order_id AS providerOrderId FROM payment_attempts
        WHERE order_id = ? AND provider_order_id IS NOT NULL`,
      [orderId],
    );
    try {
      for (const a of attempts) {
        if (!this.gateway) throw new GatewayError('payments are not configured');
        for (const p of await this.gateway.fetchOrderPayments(a.providerOrderId)) await this.applyPayment(p, 'reconcile');
      }
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      this.logger.warn(`could not check payments of order ${orderId}: ${err.message}`);
      throw new BadGatewayException({ statusCode: 502, error: 'payment_provider_unavailable', message: err.message });
    }
    const captured = await this.db.query(
      `SELECT 1 FROM payments WHERE order_id = ? AND status = 'captured' LIMIT 1`,
      [orderId],
    );
    if (captured.length > 0) this.metrics.paymentJobs.inc({ job: 'reconciled_paid' });
    return { paid: captured.length > 0 };
  }

  /** Gives back money we must not keep. A job, not the webhook: the provider call can be slow or fail. */
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

  private async refundLater(m: EntityManager, paymentId: string, reason: RefundReason): Promise<PaymentOutcome> {
    await m.query(
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
