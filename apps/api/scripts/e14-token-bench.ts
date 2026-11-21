/**
 * E14c: what does switching login tokens from HS256 (shared secret) to RS256 (private/public key) cost per token?
 *
 *   node scripts/e14-token-bench.ts            (from apps/api; one Node thread, the same library the services use)
 *
 * Signing happens once per login (identity); checking happens on every request (Kong, shop, payments).
 */
import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const claims = { sub: '01a1f957-2af9-7d28-b8ec-b660ab020053', role: 'customer' };
const opts = { issuer: 'scalecart', audience: 'scalecart-api', expiresIn: 900 };

const secret = randomBytes(32).toString('hex');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

const hs = new JwtService({ secret, signOptions: { algorithm: 'HS256', ...opts }, verifyOptions: { algorithms: ['HS256'] } });
const rs = new JwtService({ privateKey: privatePem, publicKey: publicPem, signOptions: { algorithm: 'RS256', keyid: 'k1', ...opts }, verifyOptions: { algorithms: ['RS256'] } });

/** Microseconds per call, best of 3 rounds (after a warm-up), to keep JIT and GC noise out. */
function perCall(n: number, fn: () => void): number {
  for (let i = 0; i < Math.min(n, 2_000); i++) fn();
  let best = Infinity;
  for (let round = 0; round < 3; round++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < n; i++) fn();
    best = Math.min(best, Number(process.hrtime.bigint() - start) / 1_000 / n);
  }
  return best;
}

const hsToken = hs.sign(claims);
const rsToken = rs.sign(claims);
const rows = [
  ['HS256 sign (before: the shop at login)', perCall(50_000, () => hs.sign(claims))],
  ['RS256 sign (now: identity at login)', perCall(2_000, () => rs.sign(claims))],
  ['HS256 check (before: every request)', perCall(50_000, () => hs.verify(hsToken))],
  ['RS256 check (now: every request)', perCall(20_000, () => rs.verify(rsToken))],
] as const;
for (const [name, us] of rows) console.log(`${name.padEnd(42)} ${us.toFixed(1).padStart(8)} µs   (${Math.round(1_000_000 / us).toLocaleString('en-US')} per second per core)`);
console.log(`token length: HS256 ${hsToken.length} chars, RS256 ${rsToken.length} chars`);
