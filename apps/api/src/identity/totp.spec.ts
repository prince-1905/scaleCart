import { base32Encode, hotp, matchTotp, otpauthUrl, totpStep } from './totp.js';

// RFC 6238 appendix B: SHA-1 secret "12345678901234567890" (8-digit codes there; ours are the last 6).
const RFC_SECRET = Buffer.from('12345678901234567890');

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vectors', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, code] of vectors) {
      expect(hotp(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(code);
      expect(hotp(RFC_SECRET, totpStep(seconds * 1000))).toBe(code.slice(2));
    }
  });

  it('base32-encodes the secret the way authenticator apps expect (RFC 4648)', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('accepts the codes of one step before and after (clock drift), nothing further', () => {
    const now = 1_794_800_000_000;
    const step = totpStep(now);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step), now, null)).toBe(step);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now, null)).toBeNull();
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), now, null)).toBeNull();
  });

  it('refuses a code from a step that was already used (replay)', () => {
    const now = 1_794_800_000_000;
    const step = totpStep(now);
    const code = hotp(RFC_SECRET, step);
    expect(matchTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
  });

  it('refuses anything that is not 6 digits', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 123456']) {
      expect(matchTotp(RFC_SECRET, bad, Date.now(), null)).toBeNull();
    }
  });

  it('builds the otpauth:// link for the QR code', () => {
    const url = otpauthUrl(RFC_SECRET, 'ana@x.com');
    expect(url).toBe(
      'otpauth://totp/ScaleCart%3Aana%40x.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=ScaleCart&algorithm=SHA1&digits=6&period=30',
    );
  });
});
