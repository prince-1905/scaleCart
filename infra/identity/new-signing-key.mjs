// Creates an RSA key pair for signing access tokens (Phase 11) and writes it into the repo-root .env. Never prints a key.
//
//   node infra/identity/new-signing-key.mjs            first key (fails if one exists)
//   node infra/identity/new-signing-key.mjs --rotate   new signing key; the old PUBLIC key stays accepted
//   node infra/identity/new-signing-key.mjs --prune    stop accepting old keys (after their tokens expired: 15 min)
//
// What goes where (docker-compose.yml passes them on):
//   IDENTITY_SIGNING_KEY        base64 of the private key PEM   → identity ONLY (it signs tokens)
//   IDENTITY_SIGNING_KEY_ID     the key id ("kid") in every token header
//   IDENTITY_EXTRA_PUBLIC_KEYS  kid:base64-PEM,... older public keys identity still accepts and publishes
//   IDENTITY_PUBLIC_KEYS        kid:base64-PEM,... every accepted public key → Kong (checks tokens at the door)
// The shop and payments need no key at all: they read the public keys from identity's /.well-known/jwks.json.
//
// After --rotate: recreate identity and the gateway (docker compose up -d identity gateway). Old tokens keep working
// until they expire (15 min); then the old key can be removed from both lists.
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(import.meta.dirname, '../../.env');
const text = readFileSync(file, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/);
const get = (name) => lines.find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
const set = (name, value) => {
  const at = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (at >= 0) lines[at] = `${name}=${value}`;
  else {
    while (lines.length && lines.at(-1) === '') lines.pop();
    lines.push(`${name}=${value}`);
  }
};

const rotate = process.argv.includes('--rotate');

if (process.argv.includes('--prune')) {
  const kid = get('IDENTITY_SIGNING_KEY_ID');
  const current = (get('IDENTITY_PUBLIC_KEYS') || '').split(',').find((e) => e.startsWith(`${kid}:`));
  if (!current) throw new Error('no current key in IDENTITY_PUBLIC_KEYS');
  const dropped = (get('IDENTITY_EXTRA_PUBLIC_KEYS') || '').split(',').filter(Boolean).map((e) => e.split(':')[0]);
  set('IDENTITY_EXTRA_PUBLIC_KEYS', '');
  set('IDENTITY_PUBLIC_KEYS', current);
  writeFileSync(file, lines.join(eol) + eol);
  console.log(`only key ${kid} is accepted now (dropped: ${dropped.join(', ') || 'none'})`);
  process.exit(0);
}
const oldKey = get('IDENTITY_SIGNING_KEY');
const oldKid = get('IDENTITY_SIGNING_KEY_ID');
if (oldKey && !rotate) {
  console.error('A signing key already exists in .env. Use --rotate to replace it (the old public key stays accepted).');
  process.exit(1);
}

const kid = `k${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (pem) => Buffer.from(pem).toString('base64');
const publicOf = (privatePem) => createPublicKey(privatePem).export({ type: 'spki', format: 'pem' });

const extras = (get('IDENTITY_EXTRA_PUBLIC_KEYS') || '').split(',').filter(Boolean);
if (rotate && oldKey) extras.push(`${oldKid}:${b64(publicOf(Buffer.from(oldKey, 'base64').toString()))}`);
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

set('IDENTITY_SIGNING_KEY', b64(privatePem));
set('IDENTITY_SIGNING_KEY_ID', kid);
set('IDENTITY_EXTRA_PUBLIC_KEYS', extras.join(','));
set('IDENTITY_PUBLIC_KEYS', [`${kid}:${b64(publicOf(privatePem))}`, ...extras].join(','));
writeFileSync(file, lines.join(eol) + eol);

console.log(`new signing key ${kid} written to .env${rotate && oldKid ? ` (old key ${oldKid} still accepted)` : ''}`);
console.log(`accepted key ids: ${[kid, ...extras.map((e) => e.split(':')[0])].join(', ')}`);
