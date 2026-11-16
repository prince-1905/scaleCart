import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { customer, fakeApi, renderPage } from '../test/render';
import { SecurityPage } from './Security';

const SETUP = { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/ScaleCart%3Aasha%40test.local?secret=JBSWY3DPEHPK3PXP&issuer=ScaleCart' };
const CODES = ['abcd-efgh', 'jkmn-pqrs', 'tuvw-xyz2', '3456-789a', 'bcde-fghj', 'kmnp-qrst', 'uvwx-yz23', '4567-89ab', 'cdef-ghjk', 'mnpq-rstu'];

describe('Security page', () => {
  it('turn on: QR code + key → first code → backup codes shown once', async () => {
    let me = { ...customer, twoFactorEnabled: false };
    const calls = fakeApi({
      'GET /auth/me': () => me,
      'POST /auth/2fa/setup': () => SETUP,
      'POST /auth/2fa/enable': () => {
        me = { ...me, twoFactorEnabled: true };
        return { backupCodes: CODES };
      },
    });
    renderPage(<SecurityPage />, { user: customer });

    expect(await screen.findByText('Off')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    // Drawn in the browser from the otpauth link (an SVG data URL), plus the key for typing in.
    const qr = await screen.findByAltText('QR code for your authenticator app');
    expect(qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByText(SETUP.secret)).toBeTruthy();

    await userEvent.type(screen.getByLabelText('Code from your app'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText('abcd-efgh')).toBeTruthy();
    expect(screen.getAllByRole('listitem').filter((li) => /^[a-z0-9]{4}-[a-z0-9]{4}$/.test(li.textContent ?? ''))).toHaveLength(10);
    expect(await screen.findByText('On')).toBeTruthy();
    expect(calls.find((c) => c.path === '/auth/2fa/enable')?.body).toEqual({ code: '123456' });
  });

  it('a wrong first code shows the error and stays off', async () => {
    fakeApi({
      'GET /auth/me': () => ({ ...customer, twoFactorEnabled: false }),
      'POST /auth/2fa/setup': () => SETUP,
      'POST /auth/2fa/enable': () => new Response(JSON.stringify({ statusCode: 400, error: 'invalid_code', message: 'wrong or expired code' }), { status: 400 }),
    });
    renderPage(<SecurityPage />, { user: customer });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await userEvent.type(await screen.findByLabelText('Code from your app'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText('wrong or expired code')).toBeTruthy();
    expect(screen.getByText('Off')).toBeTruthy();
  });
});
