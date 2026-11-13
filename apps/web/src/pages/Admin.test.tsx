import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Drop, DropStats, OrderStats, Product, User } from '../lib/types';
import { customer, fakeApi, renderPage } from '../test/render';
import { AdminPage } from './Admin';

const admin: User = { ...customer, id: 'a1', email: 'admin@test.local', role: 'admin' };
const totals = (orders: number, totalCents: number) => ({ orders, totalCents, orders24h: orders, totalCents24h: totalCents });
const stats: OrderStats = { byStatus: { paid: totals(3, 4_500_00), pending_payment: totals(2, 1_000_00), cancelled: totals(1, 200_00) } };

describe('Admin area', () => {
  it('sends customers away', async () => {
    fakeApi({ 'GET /auth/me': () => customer });
    renderPage(<AdminPage />, { user: customer, path: '/admin', route: '/admin' });
    expect(await screen.findByText('OTHER PAGE')).toBeTruthy();
  });

  it('overview: revenue counts paid orders only, plus the latest orders with emails', async () => {
    fakeApi({
      'GET /auth/me': () => admin,
      'GET /admin/orders/stats': () => stats,
      'GET /admin/orders': () => ({
        items: [{ id: '01900000-0000-7000-8000-000000000001', userId: 'u1', email: 'asha@test.local', status: 'paid', totalCents: 1_500_00, paymentId: 'pay_1', createdAt: new Date().toISOString() }],
        nextBefore: null,
      }),
    });
    renderPage(<AdminPage />, { user: admin, path: '/admin', route: '/admin' });
    const revenue = (await screen.findByText('Revenue (paid)')).parentElement!;
    expect(within(revenue).getByText('₹4,500')).toBeTruthy();
    expect(await screen.findByText('asha@test.local')).toBeTruthy();
  });

  it('products: editing sends the product change, and the stock only when it changed', async () => {
    const product: Product = { id: 5, sku: 'SKU-5', name: 'Trail Runner', description: '', category: 'footwear', priceCents: 2_499_00 };
    const calls = fakeApi({
      'GET /auth/me': () => admin,
      'GET /products/search': () => [product],
      'GET /inventory': () => ({ items: [{ productId: 5, available: 8 }] }),
      'PATCH /products/5': (_url, init) => ({ ...product, ...JSON.parse(String(init.body)) }),
      'PUT /inventory/5': (_url, init) => ({ productId: 5, ...JSON.parse(String(init.body)) }),
    });
    renderPage(<AdminPage />, { user: admin, path: '/admin?tab=products', route: '/admin' });
    expect(await screen.findByText('8 in stock')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const price = screen.getByLabelText('Price (₹)');
    await userEvent.clear(price);
    await userEvent.type(price, '1999.50');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved #5');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({ priceCents: 1_999_50, name: 'Trail Runner' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const stock = screen.getByLabelText(/^Stock/);
    await userEvent.clear(stock);
    await userEvent.type(stock, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findAllByText('Saved #5');
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ path: '/inventory/5', body: { available: 0 } });
  });

  it('drops: the live monitor shows the line and sales; a drop with purchases cannot be cancelled', async () => {
    const drop: Drop = {
      id: 9, name: 'Air Nova', status: 'live', startsAt: new Date(Date.now() - 60_000).toISOString(), maxPerCustomer: 1, admitPerSecond: 5,
      maxShoppers: null, product: { id: 42, name: 'Air Nova', priceCents: 9_999_00, category: 'footwear' }, available: 6, serverTime: new Date().toISOString(),
    };
    const dropStats: DropStats = { dropId: 9, ticketsIssued: 40, calledUpTo: 25, shopping: null, inLine: 15, purchases: 4, available: 6, gateCounter: 6, serverTime: drop.serverTime };
    fakeApi({ 'GET /auth/me': () => admin, 'GET /drops': () => [drop], 'GET /drops/9/stats': () => dropStats });
    renderPage(<AdminPage />, { user: admin, path: '/admin?tab=drops&drop=9', route: '/admin' });

    const waiting = (await screen.findByText('Waiting in line')).parentElement!;
    expect(within(waiting).getByText('15')).toBeTruthy();
    expect(screen.getByText('4 sold')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');
    expect((screen.getByRole('button', { name: 'Cancel drop' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
