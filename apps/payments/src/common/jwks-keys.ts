import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { createPublicKey, type JsonWebKey } from 'node:crypto';
import { ENV, type PaymentsEnv as Env } from '../config/env.js';

const REFRESH_EVERY_MS = 5 * 60_000;
/** An unknown kid triggers a refetch, but not more often than this (a flood of made-up kids must not hit identity). */
const MIN_REFETCH_GAP_MS = 10_000;

/**
 * The public keys that check access tokens (Phase 11). Since the identity split, only the identity service can SIGN a
 * token (it alone has the private key). This service only CHECKS them, with the public keys identity publishes at
 * /.well-known/jwks.json, so a leak from here could never be used to mint a token.
 *
 * Kept in memory: no call to identity per request. Refreshed every 5 minutes, and early when a token arrives with a
 * key id we don't know yet (a new key after rotation). If identity is down, the keys we already have keep working:
 * signed-in shoppers keep shopping (E14b).
 */
@Injectable()
export class JwksKeys implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JwksKeys.name);
  private keys = new Map<string, string>();
  private inFlight?: Promise<void>;
  private lastFetch = 0;
  private timer?: NodeJS.Timeout;

  constructor(@Inject(ENV) private readonly env: Env) {}

  onApplicationBootstrap() {
    // Don't block startup on identity: try now, then keep trying until the first success (and every 5 min after).
    void this.refresh(true);
    this.timer = setInterval(() => void this.refresh(true), REFRESH_EVERY_MS);
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  /** The public key (PEM) for this key id, fetching the key set again (rate-limited) if we don't know it yet. */
  async publicKeyFor(kid: string | undefined): Promise<string | undefined> {
    if (!kid) return undefined;
    if (!this.keys.has(kid)) await this.refresh(false);
    return this.keys.get(kid);
  }

  /** Test hook / status: how many keys are loaded. */
  get size() {
    return this.keys.size;
  }

  private refresh(force: boolean): Promise<void> {
    if (this.inFlight) return this.inFlight;
    // Before the first success, an unknown kid may refetch at once; after that, at most every 10 s.
    if (!force && this.keys.size > 0 && Date.now() - this.lastFetch < MIN_REFETCH_GAP_MS) return Promise.resolve();
    this.lastFetch = Date.now();
    this.inFlight = this.fetchKeys().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchKeys() {
    try {
      const res = await fetch(`${this.env.identityUrl}/.well-known/jwks.json`, {
        signal: AbortSignal.timeout(this.env.identityTimeoutMs),
      });
      if (!res.ok) throw new Error(`identity answered ${res.status}`);
      const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string; alg?: string })[] };
      const next = new Map<string, string>();
      for (const jwk of body.keys ?? []) {
        if (!jwk.kid || jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256')) continue;
        next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' }) as string);
      }
      if (next.size === 0) throw new Error('no RS256 keys in the key set');
      // Replace, not merge: a key identity stopped publishing (retired or compromised) stops being accepted.
      this.keys = next;
    } catch (err) {
      // Keep the keys we have; tokens signed with them still check out.
      this.logger.warn(`could not load the public keys from identity: ${(err as Error).message}`);
      if (this.keys.size === 0) setTimeout(() => void this.refresh(true), 2_000).unref();
    }
  }
}
