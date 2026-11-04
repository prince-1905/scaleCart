import { createHmac, timingSafeEqual } from 'node:crypto';

/** What a waiting-room pass says: this user, this drop, this ticket, valid until `exp` (epoch ms). */
export interface DropPassClaims {
  d: number;
  u: string;
  t: number;
  exp: number;
}

/**
 * The pass the waiting room hands out once a ticket is called. Checkout verifies it with
 * the signature alone: no Redis or database lookup, so checking it stays cheap and still
 * works if Redis is down.
 *
 * Format: base64url(JSON claims) + "." + base64url(HMAC-SHA256). Like a JWT, minus the header.
 */
export class DropPassSigner {
  private readonly key: Buffer;

  constructor(appSecret: string) {
    // A key of its own, derived from the app secret: a pass can never be confused with a login token.
    this.key = createHmac('sha256', appSecret).update('scalecart drop pass v1').digest();
  }

  sign(claims: DropPassClaims): string {
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  /** The claims, or null if the pass is malformed, forged or expired. */
  verify(pass: string, now = Date.now()): DropPassClaims | null {
    const [body, mac, extra] = pass.split('.');
    if (!body || !mac || extra !== undefined) return null;
    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    let claims: DropPassClaims;
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DropPassClaims;
    } catch {
      return null;
    }
    if (typeof claims.exp !== 'number' || claims.exp < now) return null;
    return claims;
  }

  private mac(body: string) {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}
