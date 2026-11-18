import { createHmac, timingSafeEqual } from 'node:crypto';

const hmacHex = (secret: string, data: string | Buffer) =>
  createHmac('sha256', secret).update(data).digest('hex');

/** Constant-time compare, so an attacker can't learn the signature byte by byte from response times. */
function sameHex(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Razorpay signs the webhook's exact bytes (X-Razorpay-Signature = HMAC-SHA256 of the
 * raw body with the webhook secret). Parsing and re-serializing the JSON would change
 * the bytes, so this must get the raw body.
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  return sameHex(hmacHex(secret, rawBody), signature);
}

/**
 * The browser's "payment succeeded" proof: HMAC-SHA256("<order_id>|<payment_id>") with
 * the key secret. `providerOrderId` must be the one WE stored, not one the browser sent.
 */
export function verifyCheckoutSignature(
  providerOrderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): boolean {
  return sameHex(hmacHex(keySecret, `${providerOrderId}|${paymentId}`), signature);
}

/** For tests and the experiment scripts: sign a body the way Razorpay does. */
export const signWebhook = (rawBody: string | Buffer, secret: string) => hmacHex(secret, rawBody);
export const signCheckout = (providerOrderId: string, paymentId: string, keySecret: string) =>
  hmacHex(keySecret, `${providerOrderId}|${paymentId}`);
