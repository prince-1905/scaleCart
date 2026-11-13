import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Link } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { Layout } from './components/Layout';
import { EmptyState, ToastProvider } from './components/ui';
import './index.css';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import { RequireAuth } from './components/RequireAuth';
import { DropsPage } from './pages/Drops';
import { Home } from './pages/Home';
import { Shop } from './pages/Shop';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Retrying a 4xx (not found, forbidden…) can't help; network blips and 5xx get one more try.
      retry: (failures, err) => failures < 1 && !(err instanceof ApiError && err.status < 500),
    },
  },
});

function NotFound() {
  return (
    <EmptyState emoji="🧭" title="This page doesn't exist">
      <Link to="/" className="font-semibold text-brand-600 hover:underline">Back to the shop</Link>
    </EmptyState>
  );
}

const router = createBrowserRouter(
  [
    {
      element: <Layout />,
      children: [
        { index: true, element: <Home /> },
        { path: 'products', element: <Shop /> },
        { path: 'drops', element: <DropsPage /> },
        // Loaded on first visit (code splitting): the home page and the shop don't pay for them.
        { path: 'products/:id', lazy: async () => ({ Component: (await import('./pages/Product')).ProductPage }) },
        { path: 'cart', lazy: async () => { const { CartPage } = await import('./pages/Cart'); return { Component: () => <RequireAuth><CartPage /></RequireAuth> }; } },
        { path: 'orders', lazy: async () => { const { OrdersPage } = await import('./pages/Orders'); return { Component: () => <RequireAuth><OrdersPage /></RequireAuth> }; } },
        { path: 'orders/:id', lazy: async () => { const { OrderPage } = await import('./pages/Orders'); return { Component: () => <RequireAuth><OrderPage /></RequireAuth> }; } },
        { path: 'admin', lazy: async () => { const { AdminPage } = await import('./pages/Admin'); return { Component: () => <RequireAuth><AdminPage /></RequireAuth> }; } },
        { path: 'login', lazy: async () => { const { AuthPage } = await import('./pages/Auth'); return { Component: () => <AuthPage mode="login" /> }; } },
        { path: 'register', lazy: async () => { const { AuthPage } = await import('./pages/Auth'); return { Component: () => <AuthPage mode="register" /> }; } },
        { path: '*', element: <NotFound /> },
      ],
    },
  ],
  { basename: '/shop' },
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
