/**
 * E15g: recreate the shop and identity containers (Docker may swap their IPs) and probe both through NGINX -> Kong
 * every 250 ms for 60 s: how long until Kong reaches the new containers?
 *
 *   node load-tests/e15-kong-dns.mjs
 */
import { exec } from 'node:child_process';
import { resolve } from 'node:path';
const sh = (c) => new Promise((ok, fail) => exec(c, { cwd: resolve(import.meta.dirname, '..') }, (e, out) => (e ? fail(e) : ok(out.trim()))));
const ip = async (n) => sh(`docker inspect scalecart-${n} --format "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"`);
console.log('before: api', await ip('api-4'), 'identity', await ip('identity-1'));
const t0 = performance.now();
const s = () => ((performance.now() - t0) / 1000).toFixed(1);
sh('docker compose up -d --force-recreate --no-deps api identity').then(() => console.log(`recreate returned at ${s()} s`), (e) => console.log('recreate failed', e.message));
const stat = { shop: { fails: {}, last: '-' }, identity: { fails: {}, last: '-' } };
while (performance.now() - t0 < 60_000) {
  await Promise.all(
    [['shop', 'http://localhost:8088/products/1'], ['identity', 'http://localhost:8088/.well-known/jwks.json']].map(async ([k, url]) => {
      let code = 0;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
        await r.text();
        code = r.status;
      } catch {}
      if (code !== 200) {
        stat[k].fails[code] = (stat[k].fails[code] ?? 0) + 1;
        stat[k].last = s();
      }
    }),
  );
  await new Promise((r) => setTimeout(r, 250));
}
console.log('after: api', await ip('api-4'), 'identity', await ip('identity-1'));
console.log('failures (status:count) and the last failure, s after the recreate began:', JSON.stringify(stat));
