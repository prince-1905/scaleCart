/** Helpers for scripts that act as logged-in shoppers. */
import http from 'k6/http';
import { BASE_URL } from './steps.js';

export const JSON_HEADERS = { 'Content-Type': 'application/json' };
export const ADMIN_EMAIL = __ENV.ADMIN_EMAIL || 'admin@scalecart.local';
export const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || 'dev-admin-password';
export const USER_PASSWORD = __ENV.SEED_USER_PASSWORD || 'loadtest-password';

/** Seeded by `SEED_USERS=n node dist/seed.js`. */
export const loadTestEmail = (n) => `loadtest+${n}@scalecart.local`;

export const auth = (token, extra = {}) => ({
  headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}`, ...extra },
});

export function login(email, password) {
  const res = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password }), {
    headers: JSON_HEADERS,
    tags: { name: 'login' },
  });
  if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${res.body}`);
  return res.json('accessToken');
}

/** Logs in users 1..count in parallel batches; returns their access tokens. */
export function loginMany(count, batchSize = 50) {
  const tokens = [];
  for (let start = 1; start <= count; start += batchSize) {
    const n = Math.min(batchSize, count - start + 1);
    const responses = http.batch(
      Array.from({ length: n }, (_, k) => [
        'POST',
        `${BASE_URL}/auth/login`,
        JSON.stringify({ email: loadTestEmail(start + k), password: USER_PASSWORD }),
        { headers: JSON_HEADERS, tags: { name: 'setup-login' } },
      ]),
    );
    for (const res of responses) {
      if (res.status !== 200) throw new Error(`setup login failed: ${res.status} ${res.body}`);
      tokens.push(res.json('accessToken'));
    }
  }
  return tokens;
}

/** A fresh product for this run, so runs never share stock. */
export function createProduct(adminToken, available, priceCents = 4999) {
  const sku = `DROP-${Date.now()}`;
  const product = http.post(
    `${BASE_URL}/products`,
    JSON.stringify({ sku, name: `Limited drop ${sku}`, priceCents }),
    auth(adminToken),
  );
  if (product.status !== 201) throw new Error(`create product: ${product.status} ${product.body}`);
  const id = product.json('id');
  const stock = http.put(`${BASE_URL}/inventory/${id}`, JSON.stringify({ available }), auth(adminToken));
  if (stock.status !== 200) throw new Error(`set stock: ${stock.status} ${stock.body}`);
  return id;
}

export function available(productId) {
  return http.get(`${BASE_URL}/inventory/${productId}`).json('available');
}
