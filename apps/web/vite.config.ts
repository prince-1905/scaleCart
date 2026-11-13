import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API keeps its root paths (/products, /cart, /drops…), so the shop lives under /shop/.
// In development everything that isn't the shop goes to the API (Docker Compose + NGINX on :8088),
// so the browser sees one origin and needs no CORS.
const API_URL = process.env.API_URL ?? 'http://localhost:8088';

export default defineConfig({
  base: '/shop/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '^/(?!shop)': { target: API_URL, changeOrigin: true } },
  },
});
