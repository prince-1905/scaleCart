import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RequireAuth } from '../components/RequireAuth';
import { customer, fakeApi, renderPage } from '../test/render';
import { CartPage } from './Cart';

vi.mock('../lib/razorpay', () => ({ payForOrder: vi.fn(async () => {}) }));

const cart = {
  items: [{ productId: 3, sku: 'S3', name: 'Stride Lite', unitPriceCents: 249900, quantity: 2, lineTotalCents: 499800 }],
  totalCents: 499800,
};

describe('Cart and checkout', () => {
  it('logged-out visitors are sent to login, with a way back', async () => {
    fakeApi({});
    renderPage(<RequireAuth><CartPage /></RequireAuth>, { path: '/cart', route: '/cart' });
    expect(await screen.findByText('LOGIN PAGE')).toBeTruthy();
  });

  it('checkout sends the total the customer saw and an Idempotency-Key, then starts payment', async () => {
    const { payForOrder } = await import('../lib/razorpay');
    const calls = fakeApi({
      'GET /auth/me': () => customer,
      'GET /cart': () => cart,
      'GET /products': () => ({ items: [], nextAfter: null }),
      'POST /checkout': () => ({ id: 'order-1', status: 'pending_payment', totalCents: 499800, items: [], createdAt: new Date().toISOString() }),
    });
    renderPage(<CartPage />, { user: customer, path: '/cart', route: '/cart' });

    expect(await screen.findByText('Stride Lite')).toBeTruthy();
    expect(screen.getAllByText('₹4,998').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Checkout & pay' }));

    const checkout = calls.find((c) => c.path === '/checkout');
    expect(checkout?.body).toEqual({ expectedTotalCents: 499800 });
    const init = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.find(([p]) => p === '/checkout')![1];
    expect((init.headers as Record<string, string>)['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(payForOrder).toHaveBeenCalledWith('order-1', customer.email);
  });

  it('a price change refuses the order and shows why', async () => {
    fakeApi({
      'GET /auth/me': () => customer,
      'GET /cart': () => cart,
      'GET /products': () => ({ items: [], nextAfter: null }),
      'POST /checkout': () =>
        new Response(JSON.stringify({ statusCode: 409, error: 'price_changed', message: 'the cart total changed since it was shown' }), { status: 409 }),
    });
    renderPage(<CartPage />, { user: customer, path: '/cart', route: '/cart' });
    await userEvent.click(await screen.findByRole('button', { name: 'Checkout & pay' }));
    expect(await screen.findByText('the cart total changed since it was shown')).toBeTruthy();
  });
});
