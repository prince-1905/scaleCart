import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import { tokens } from '../lib/api';
import { AuthProvider } from '../lib/auth';
import type { User } from '../lib/types';

type Handler = (url: URL, init: RequestInit) => unknown;

/**
 * A fake API: `routes` maps "METHOD /path" to a handler returning the JSON body
 * (or a Response for other statuses). Unknown routes answer 404. Returns the list of calls made.
 */
export function fakeApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://shop.test');
      const method = init.method ?? 'GET';
      calls.push({ method, path: url.pathname + url.search, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const handler = routes[`${method} ${url.pathname}`];
      if (!handler) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
      const result = await handler(url, init);
      return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

export const customer: User = { id: 'u1', email: 'asha@test.local', role: 'customer', createdAt: '2026-11-01T00:00:00Z' };

/** Renders `ui` at `path` with the app's providers; `user` = signed in as that user (needs a GET /auth/me route). */
export function renderPage(ui: ReactNode, { path = '/', route = '/', user }: { path?: string; route?: string; user?: User } = {}) {
  localStorage.clear();
  if (user) tokens.set({ accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 900 });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: route, element: ui },
      { path: '/login', element: <p>LOGIN PAGE</p> },
      { path: '*', element: <p>OTHER PAGE</p> },
    ],
    { initialEntries: [path] },
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}
