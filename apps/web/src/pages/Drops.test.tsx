import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { customer, fakeApi, renderPage } from '../test/render';
import type { Drop, QueueStatus } from '../lib/types';
import { DropsPage } from './Drops';

const now = Date.now();
const drop = (over: Partial<Drop> = {}): Drop => ({
  id: 7,
  name: 'Stride X Limited',
  status: 'upcoming',
  startsAt: new Date(now + 5 * 60_000).toISOString(),
  maxPerCustomer: 1,
  admitPerSecond: 50,
  maxShoppers: null,
  product: { id: 42, name: 'Stride X Limited', priceCents: 99900, category: 'footwear' },
  available: 20,
  serverTime: new Date(now).toISOString(),
  ...over,
});

describe('Drops page', () => {
  it('shows a countdown on the server clock, and asks visitors to log in', async () => {
    fakeApi({ 'GET /drops': () => [drop()] });
    renderPage(<DropsPage />);
    expect(await screen.findByText('Stride X Limited')).toBeTruthy();
    expect(screen.getByText(/^0[45]:\d\d$/)).toBeTruthy(); // ~5 minutes to go
    expect(screen.getByRole('button', { name: 'Log in to join the line' })).toBeTruthy();
  });

  it('join the line → your ticket and place; once called → Buy now', async () => {
    let status: QueueStatus = { dropId: 7, ticket: 57, admittedUpTo: 12, position: 45, etaSeconds: 1, admitted: false };
    const calls = fakeApi({
      'GET /auth/me': () => customer,
      'GET /drops': () => [drop({ startsAt: new Date(now - 1000).toISOString(), status: 'live' })],
      'POST /drops/7/queue': () => status,
    });
    renderPage(<DropsPage />, { user: customer });

    await userEvent.click(await screen.findByRole('button', { name: 'Join the line' }));
    expect(await screen.findByText('#57')).toBeTruthy();
    expect(screen.getByText('45 ahead of you')).toBeTruthy();

    // The number is called: the page asks again by itself and switches to Buy now.
    status = { ...status, admittedUpTo: 60, position: 0, admitted: true, pass: 'signed.pass', passExpiresAt: new Date(now + 60_000).toISOString() };
    expect(await screen.findByRole('button', { name: /Buy now/ }, { timeout: 3000 })).toBeTruthy();
    expect(calls.filter((c) => c.path === '/drops/7/queue').length).toBeGreaterThanOrEqual(2);
  });

  it('Buy now orders just the drop item and never touches the cart', async () => {
    const calls = fakeApi({
      'GET /auth/me': () => customer,
      'GET /drops': () => [drop({ startsAt: new Date(now - 1000).toISOString(), status: 'live' })],
      'POST /drops/7/queue': () => ({ dropId: 7, ticket: 1, admittedUpTo: 5, position: 0, etaSeconds: 0, admitted: true, pass: 'signed.pass', passExpiresAt: new Date(now + 60_000).toISOString() }),
      // Sold out at the last moment: the attempt fails, and must leave nothing behind in the cart.
      'POST /checkout': () => new Response(JSON.stringify({ statusCode: 409, error: 'out_of_stock', message: 'sold out' }), { status: 409 }),
    });
    renderPage(<DropsPage />, { user: customer });
    await userEvent.click(await screen.findByRole('button', { name: 'Join the line' }));
    await userEvent.click(await screen.findByRole('button', { name: /Buy now/ }));
    await screen.findByText('sold out');

    expect(calls.find((c) => c.path === '/checkout')?.body).toEqual({ dropPass: 'signed.pass', buyNow: { productId: 42, quantity: 1 } });
    expect(calls.some((c) => c.path.startsWith('/cart'))).toBe(false);
  });

  it('if it sells out while you wait, the line tells you it is closed', async () => {
    fakeApi({
      'GET /auth/me': () => customer,
      'GET /drops': () => [drop({ startsAt: new Date(now - 1000).toISOString(), status: 'live', available: 1 })],
      'POST /drops/7/queue': () => ({ dropId: 7, ticket: 0, admittedUpTo: 0, position: 0, etaSeconds: 0, admitted: false, soldOut: true }),
    });
    renderPage(<DropsPage />, { user: customer });
    await userEvent.click(await screen.findByRole('button', { name: 'Join the line' }));
    expect(await screen.findByText('Sold out: the line is closed.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Buy now/ })).toBeNull();
  });

  it('a sold-out drop offers nothing to click', async () => {
    fakeApi({ 'GET /drops': () => [drop({ available: 0 })] });
    renderPage(<DropsPage />);
    expect(await screen.findByText('SOLD OUT')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Join the line|Log in/ })).toBeNull();
  });
});

describe('Drops page for staff', () => {
  it("an admin sees why they can't join, and no Join button", async () => {
    const calls = fakeApi({
      'GET /auth/me': () => ({ ...customer, role: 'admin' }),
      'GET /drops': () => [drop({ startsAt: new Date(now - 1000).toISOString(), status: 'live' })],
    });
    renderPage(<DropsPage />, { user: { ...customer, role: 'admin' } });
    expect(await screen.findByText(/Staff can't join drops/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join the line' })).toBeNull();
    expect(calls.some((c) => c.path.endsWith('/queue'))).toBe(false);
  });
});
