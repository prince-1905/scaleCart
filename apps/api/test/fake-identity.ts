import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the identity service (Phase 11) in e2e tests: its own RSA key pair, the public half served at
 * /.well-known/jwks.json, users' emails at /internal/users, and `sign()` for access tokens exactly like identity issues
 * them (RS256, kid in the header, issuer "scalecart", audience "scalecart-api").
 * mode 'down' = every request answers 503, like an outage.
 */
export class FakeIdentity {
  readonly kid = 'test-key-1';
  readonly emails = new Map<string, string>();
  mode: 'up' | 'down' = 'up';
  calls = 0;
  url = '';
  private readonly jwt: JwtService;
  private readonly jwk: Record<string, unknown>;
  private server?: Server;

  constructor(private readonly serviceToken: string) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.jwt = new JwtService({ privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string });
    const { kty, n, e } = publicKey.export({ format: 'jwk' });
    this.jwk = { kty, n, e, kid: this.kid, alg: 'RS256', use: 'sig' };
  }

  async start() {
    this.server = createServer((req, res) => {
      this.calls++;
      if (this.mode === 'down') return res.writeHead(503).end();
      const url = new URL(req.url ?? '/', 'http://x');
      const json = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (url.pathname === '/.well-known/jwks.json') return json({ keys: [this.jwk] });
      if (url.pathname === '/internal/users') {
        if (req.headers['x-service-token'] !== this.serviceToken) return res.writeHead(401).end();
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
        // Test files run in parallel processes, each with its own fake, but share the test queues: a worker in another
        // process may ask about this process's users. So every fake answers the same, derived address (u-<id>@test.local)
        // unless a test set one explicitly.
        return json({ users: ids.map((id) => ({ id, email: this.emails.get(id) ?? `u-${id}@test.local` })) });
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.server.unref(); // a leftover test server must not keep the test run alive
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  /** An access token like identity's. `audience` / `expiresIn` / `kid` can be bent to test the checks. */
  sign(
    claims: { sub: string; role: 'customer' | 'admin'; email?: string },
    opts: { audience?: string; expiresIn?: number; kid?: string } = {},
  ): string {
    return this.jwt.sign(claims, {
      algorithm: 'RS256',
      keyid: opts.kid ?? this.kid,
      issuer: 'scalecart',
      audience: opts.audience ?? 'scalecart-api',
      expiresIn: opts.expiresIn ?? 900,
    });
  }

  stop() {
    this.server?.closeAllConnections();
    this.server?.close();
  }
}
