import { describe, expect, it } from 'vitest';
import { DropPassSigner } from './drop-pass.js';
import { admittedUpTo } from './waiting-room.js';

describe('admittedUpTo (how far the line has moved)', () => {
  const drop = { id: 1, startsAt: new Date('2026-11-05T10:00:00.000Z'), admitPerSecond: 50, maxShoppers: null };
  const at = (iso: string) => new Date(iso).getTime();

  it('calls nobody before the start', () => {
    expect(admittedUpTo(drop, at('2026-11-05T09:59:59.999Z'))).toBe(0);
    expect(admittedUpTo(drop, at('2026-11-05T10:00:00.000Z'))).toBe(0);
  });

  it('then moves at the admit rate, in whole tickets', () => {
    expect(admittedUpTo(drop, at('2026-11-05T10:00:00.019Z'))).toBe(0);
    expect(admittedUpTo(drop, at('2026-11-05T10:00:00.020Z'))).toBe(1);
    expect(admittedUpTo(drop, at('2026-11-05T10:00:01.000Z'))).toBe(50);
    expect(admittedUpTo(drop, at('2026-11-05T10:00:20.000Z'))).toBe(1000);
  });
});

describe('DropPassSigner', () => {
  const signer = new DropPassSigner('app-secret-0123456789-0123456789');
  const claims = { d: 7, u: 'user-1', t: 42, exp: 2_000 };

  it('verifies its own pass until it expires', () => {
    const pass = signer.sign(claims);
    expect(signer.verify(pass, 1_999)).toEqual(claims);
    expect(signer.verify(pass, 2_001)).toBeNull();
  });

  it('rejects a pass with changed claims, a forged signature, or another key', () => {
    const pass = signer.sign(claims);
    const [, mac] = pass.split('.');
    const otherClaims = Buffer.from(JSON.stringify({ ...claims, u: 'user-2' })).toString('base64url');
    expect(signer.verify(`${otherClaims}.${mac}`, 0)).toBeNull();
    expect(signer.verify(`${pass}x`, 0)).toBeNull();
    expect(signer.verify('not-a-pass', 0)).toBeNull();
    expect(new DropPassSigner('another-secret-0123456789-012345').verify(pass, 0)).toBeNull();
  });
});
