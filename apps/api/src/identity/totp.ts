import { createHmac, randomBytes } from 'node:crypto';

/**
 * TOTP (RFC 6238), the codes authenticator apps show. Built on node:crypto only.
 *
 * Phone and server share a random secret (shown once as a QR code). Neither talks to the other:
 * both compute  code = HOTP(secret, floor(unix time / 30 s))  and the server compares.
 * HOTP (RFC 4226) = HMAC-SHA1(secret, counter) → pick 4 bytes at an offset from the last byte →
 * a 31-bit number → last 6 digits.
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Codes from one step before or after are accepted too: phone and server clocks differ a little. */
export const TOTP_WINDOW_STEPS = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 160 random bits, the size RFC 4226 recommends for HMAC-SHA1. */
export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

/** Authenticator apps take the secret as base32 (A–Z, 2–7). */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The time step a moment falls in (30 s slots since 1970). */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const number = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(number % 10 ** digits).padStart(digits, '0');
}

/**
 * The step whose code matches, or null. Only steps after `lastUsedStep` count: a code that
 * already logged someone in can't be replayed (by someone looking over a shoulder, say).
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(nowMs);
  let matched: number | null = null;
  // Every candidate is checked (no early exit), so timing doesn't hint which step matched.
  for (let step = now - TOTP_WINDOW_STEPS; step <= now + TOTP_WINDOW_STEPS; step++) {
    const fresh = lastUsedStep === null || step > lastUsedStep;
    if (safeEqual(hotp(secret, step), code) && fresh && matched === null) matched = step;
  }
  return matched;
}

/** The link inside the QR code: otpauth://totp/ScaleCart:ana@x.com?secret=…&issuer=ScaleCart */
export function otpauthUrl(secret: Buffer, account: string, issuer = 'ScaleCart'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
