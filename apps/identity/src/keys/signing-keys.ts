import { createPrivateKey, createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { Env } from '../config/env.js';

export interface PublicJwk extends JsonWebKey {
  kid: string;
  alg: 'RS256';
  use: 'sig';
}

/**
 * The keys behind access tokens (Phase 11).
 *
 *   private key  signs tokens; lives ONLY in this service. Whoever has it can log in as anyone.
 *   public keys  check tokens; published at /.well-known/jwks.json for the gateway and the other services.
 *                They can verify a token but never create one, so a leak from the shop or payments is no takeover.
 *
 * Each key has an id (`kid`, put in every token's header). Rotation: make a new key, sign with it, keep publishing the
 * old public key until the last token signed with it has expired (15 min), then drop it.
 */
export class SigningKeys {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  private readonly byKid = new Map<string, KeyObject>();

  constructor(env: Pick<Env, 'signingKey' | 'extraPublicKeys'>) {
    this.kid = env.signingKey.kid;
    this.privateKey = createPrivateKey(env.signingKey.pem);
    const bits = this.privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
    if (this.privateKey.asymmetricKeyType !== 'rsa' || bits < 2048) {
      throw new Error(`the signing key must be RSA with at least 2048 bits (got ${this.privateKey.asymmetricKeyType} ${bits})`);
    }
    this.publicKey = createPublicKey(this.privateKey);
    this.byKid.set(this.kid, this.publicKey);
    for (const extra of env.extraPublicKeys) this.byKid.set(extra.kid, createPublicKey(extra.pem));
  }

  /** The public key (PEM) for a token's `kid`, if we accept it. */
  publicKeyFor(kid: string | undefined): string | undefined {
    const key = kid ? this.byKid.get(kid) : undefined;
    return key ? (key.export({ type: 'spki', format: 'pem' }) as string) : undefined;
  }

  /** What /.well-known/jwks.json serves: the public half of every accepted key, never the private key. */
  jwks(): { keys: PublicJwk[] } {
    return {
      keys: [...this.byKid].map(([kid, key]) => {
        const { kty, n, e } = key.export({ format: 'jwk' });
        return { kty, n, e, kid, alg: 'RS256', use: 'sig' };
      }),
    };
  }
}
