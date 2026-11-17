import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { customer, fakeApi, renderPage } from '../test/render';
import { tokens } from '../lib/api';
import { AuthPage } from './Auth';

describe('Log in with two-step verification', () => {
  it('password → asks for the code → code → signed in (no tokens before the code)', async () => {
    const calls = fakeApi({
      'POST /auth/login': () => ({ twoFactorRequired: true, challengeToken: 'challenge-1', expiresIn: 300 }),
      'POST /auth/login/2fa': () => ({ tokenType: 'Bearer', accessToken: 'a', refreshToken: 'r', expiresIn: 900 }),
      'GET /auth/me': () => ({ ...customer, twoFactorEnabled: true }),
    });
    renderPage(<AuthPage mode="login" />, { path: '/login-page', route: '/login-page' });

    await userEvent.type(screen.getByLabelText('Email'), customer.email);
    await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText('Two-step verification')).toBeTruthy();
    expect(tokens.get()).toBeNull();

    await userEvent.type(screen.getByLabelText('Code'), '482913');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText('OTHER PAGE')).toBeTruthy(); // navigated on to "/"
    expect(tokens.get()?.accessToken).toBe('a');
    expect(calls.find((c) => c.path === '/auth/login/2fa')?.body).toEqual({ challengeToken: 'challenge-1', code: '482913' });
  });

  it('a wrong code shows the error and keeps asking', async () => {
    fakeApi({
      'POST /auth/login': () => ({ twoFactorRequired: true, challengeToken: 'c', expiresIn: 300 }),
      'POST /auth/login/2fa': () => new Response(JSON.stringify({ statusCode: 401, error: 'invalid_code', message: 'wrong or expired code' }), { status: 401 }),
    });
    renderPage(<AuthPage mode="login" />, { path: '/login-page', route: '/login-page' });
    await userEvent.type(screen.getByLabelText('Email'), customer.email);
    await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await userEvent.type(await screen.findByLabelText('Code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('wrong or expired code')).toBeTruthy();
    expect(screen.getByText('Two-step verification')).toBeTruthy();
    expect(tokens.get()).toBeNull();
  });
});
