import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ENV, type Env } from '../config/env.js';
import { MetricsService } from '../observability/metrics.service.js';
import { PaymentsService, type PaymentOutcome } from './payments.service.js';
import { parseRazorpayEvent } from './razorpay-gateway.js';
import { verifyWebhookSignature } from './signatures.js';

/** Events that carry a payment we act on. Anything else is acknowledged and ignored. */
const PAYMENT_EVENTS = new Set(['payment.captured', 'payment.failed', 'order.paid']);

/**
 * Receives Razorpay's webhooks. Razorpay delivers each event at least once, maybe out of
 * order, and retries for 24 h whenever we don't answer 2xx within 5 s. So:
 *
 * 1. Check the signature over the raw body; forged or altered requests get 400.
 * 2. Record the event id. A repeat of an event we finished is answered 200 at once.
 * 3. Apply the payment (safe to repeat), then mark the event processed.
 * 4. If anything fails, answer 500: Razorpay retries, and the retry finishes the job.
 *
 * Step 2 is only a shortcut. Correctness comes from applyPayment being repeatable: two
 * copies of one event processed at the same instant still change the order once.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @InjectDataSource('payments') private readonly db: DataSource,
    private readonly payments: PaymentsService,
    private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async handleRazorpay(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    eventIdHeader: string | undefined,
  ): Promise<{ status: 'processed' | 'duplicate'; outcome: PaymentOutcome | 'ignored' }> {
    if (!this.env.razorpayWebhookSecret) {
      throw new ServiceUnavailableException('webhooks are not configured (RAZORPAY_WEBHOOK_SECRET)');
    }
    if (!rawBody || !signature || !verifyWebhookSignature(rawBody, signature, this.env.razorpayWebhookSecret)) {
      this.count('?', 'bad_signature');
      // Loud on purpose: in the first live test every real webhook failed here (the dashboard's
      // secret didn't match .env) and only a counter showed it. The provider retries for 24 h.
      this.logger.warn(
        `webhook rejected: ${signature ? 'signature mismatch (is the dashboard secret the same as RAZORPAY_WEBHOOK_SECRET?)' : 'no signature'}` +
          ` event=${eventIdHeader ?? '?'} bytes=${rawBody?.length ?? 0}`,
      );
      throw new BadRequestException('invalid webhook signature');
    }

    let parsed: ReturnType<typeof parseRazorpayEvent>;
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
      parsed = parseRazorpayEvent(body);
    } catch {
      this.count('?', 'malformed');
      throw new BadRequestException('malformed webhook body');
    }
    // Razorpay always sends the id; fall back to the body's hash so a repeat is still recognised.
    const eventId = (eventIdHeader || createHash('sha256').update(rawBody).digest('hex')).slice(0, 64);

    await this.db.query(
      `INSERT INTO webhook_events (event_id, event, payload) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE deliveries = deliveries + 1`,
      [eventId, parsed.event, JSON.stringify(body)],
    );
    const [seen] = await this.db.query(
      'SELECT outcome FROM webhook_events WHERE event_id = ? AND processed_at IS NOT NULL',
      [eventId],
    );
    if (seen) {
      this.count(parsed.event, 'duplicate');
      return { status: 'duplicate', outcome: seen.outcome };
    }

    let outcome: PaymentOutcome | 'ignored' = 'ignored';
    if (PAYMENT_EVENTS.has(parsed.event) && parsed.payment) {
      outcome = await this.payments.applyPayment(parsed.payment, 'webhook');
    }
    await this.db.query(
      'UPDATE webhook_events SET outcome = ?, processed_at = NOW(3) WHERE event_id = ? AND processed_at IS NULL',
      [outcome, eventId],
    );
    this.count(parsed.event, outcome);
    this.logger.log(`webhook ${parsed.event} ${eventId}: ${outcome}`);
    return { status: 'processed', outcome };
  }

  /** Delivered events are kept for 30 days as an audit trail, then deleted in small batches. */
  async deleteOlderThan(days: number): Promise<number> {
    let total = 0;
    for (;;) {
      const r: { affectedRows: number } = await this.db.query(
        'DELETE FROM webhook_events WHERE received_at < NOW(3) - INTERVAL ? DAY LIMIT 1000',
        [days],
      );
      total += r.affectedRows;
      if (r.affectedRows < 1000) return total;
    }
  }

  private count(event: string, result: string) {
    this.metrics.paymentWebhooks.inc({ event, result });
  }
}
