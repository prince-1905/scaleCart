import {
  Body,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Redirect,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { IsString, Matches, MaxLength } from 'class-validator';
import { CurrentUser, Internal, Public, type AuthUser } from '../common/auth.js';
import { UUID_PATTERN } from '../common/uuid.js';
import { PaymentsService } from './payments.service.js';
import { WebhookService } from './webhook.service.js';

const PROVIDER_ID = /^[A-Za-z0-9_]{1,40}$/;
const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : undefined);

/** What Razorpay Checkout hands the browser after a successful payment. */
export class ConfirmPaymentDto {
  @Matches(PROVIDER_ID)
  providerOrderId: string;

  @Matches(PROVIDER_ID)
  paymentId: string;

  @IsString()
  @MaxLength(128)
  signature: string;
}

/** The same public URLs as when payments lived in the shop: NGINX routes them here, the browser can't tell. */
@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly webhooks: WebhookService,
  ) {}

  @Post('orders/:id/payment')
  @HttpCode(201)
  start(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    if (!UUID_PATTERN.test(id)) throw new NotFoundException('order not found');
    return this.payments.startPayment(user.id, id);
  }

  @Post('payments/razorpay/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() user: AuthUser, @Body() dto: ConfirmPaymentDto) {
    return this.payments.confirmFromBrowser(user.id, dto);
  }

  /** Razorpay Checkout's redirect mode: settle what we can, then send the browser back to its order page. */
  @Public()
  @Post('payments/razorpay/callback')
  @Redirect()
  async callback(
    @Query('order') order: string | undefined,
    @Query('return') returnTo: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const orderId = order && UUID_PATTERN.test(order) ? order : '';
    // Always a fixed same-site path: never redirect to anything taken from the request.
    const back = (params: Record<string, string>) => ({
      url:
        returnTo === 'shop' && orderId
          ? `/shop/orders/${orderId}?${new URLSearchParams(params)}`
          : `/demo/?${new URLSearchParams({ order: orderId, ...params })}`,
      statusCode: 303,
    });

    const paymentId = text(body.razorpay_payment_id);
    const providerOrderId = text(body.razorpay_order_id);
    const signature = text(body.razorpay_signature);
    if (paymentId && providerOrderId && signature) {
      if (!PROVIDER_ID.test(paymentId) || !PROVIDER_ID.test(providerOrderId)) return back({ payment: 'error' });
      try {
        const result = await this.payments.confirmFromBrowser(null, { providerOrderId, paymentId, signature });
        return back({ payment: result.outcome });
      } catch {
        return back({ payment: 'error' });
      }
    }
    const nested = body.error as Record<string, unknown> | undefined;
    const reason = text(body['error[description]']) ?? text(nested?.description) ?? 'payment failed';
    return back({ payment: 'failed', reason: reason.slice(0, 200) });
  }

  /** Razorpay calls this. No login: the HMAC signature over the raw body is the authentication. */
  @Public()
  @Post('payments/razorpay/webhook')
  @HttpCode(200)
  webhook(
    @Req() req: RawBodyRequest<{ rawBody?: Buffer }>,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
  ) {
    return this.webhooks.handleRazorpay(req.rawBody, signature, eventId);
  }

  /** The shop's expiry job asks this before cancelling an unpaid order. Service token only; NGINX never routes /internal. */
  @Internal()
  @Post('internal/orders/:id/reconcile')
  @HttpCode(200)
  reconcile(@Param('id') id: string) {
    if (!UUID_PATTERN.test(id)) throw new NotFoundException('order not found');
    return this.payments.reconcileOrder(id);
  }
}
