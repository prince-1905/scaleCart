import { api } from './api';
import type { PaymentSession } from './types';

interface RazorpayCheckout {
  open(): void;
}
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayCheckout;
  }
}

let script: Promise<void> | null = null;

/** Razorpay's checkout script, loaded only when someone pays. */
function loadRazorpay(): Promise<void> {
  script ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => {
      script = null;
      reject(new Error('Could not load Razorpay Checkout'));
    };
    document.head.append(s);
  });
  return script;
}

/**
 * Opens Razorpay for one of our orders. Redirect mode: the bank page replaces this page (pop-ups were blocked in
 * testing, E4a). Razorpay then POSTs the result to our API, which checks it and sends the browser back to
 * /shop/orders/:id?payment=…. The order is settled by Razorpay's webhook either way.
 */
export async function payForOrder(orderId: string, email?: string): Promise<void> {
  const session = await api<PaymentSession>(`/orders/${orderId}/payment`, { method: 'POST' });
  await loadRazorpay();
  const secondsLeft = Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000);
  new window.Razorpay!({
    key: session.keyId,
    order_id: session.providerOrderId,
    amount: session.amountPaise,
    currency: session.currency,
    name: 'ScaleCart (test mode)',
    description: `Order #${orderId.slice(-6)}`,
    prefill: { email: email ?? '' },
    // Close the payment page before our order expires, so nobody pays for a cancelled order.
    timeout: Math.max(secondsLeft - 30, 30),
    theme: { color: '#5b4bdb' },
    redirect: true,
    callback_url: `${location.origin}/payments/razorpay/callback?order=${orderId}&return=shop`,
  }).open();
}
