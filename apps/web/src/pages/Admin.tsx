import { Navigate, useSearchParams } from 'react-router';
import { Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useTitle } from '../lib/title';
import { AdminDrops } from './admin/AdminDrops';
import { AdminOrders } from './admin/AdminOrders';
import { AdminProducts } from './admin/AdminProducts';
import { Overview } from './admin/Overview';
import { ProductCopy } from './admin/ProductCopy';

const TABS = [
  { id: 'overview', label: 'Overview', emoji: '📊' },
  { id: 'orders', label: 'Orders', emoji: '🧾' },
  { id: 'products', label: 'Products', emoji: '📦' },
  { id: 'drops', label: 'Drops', emoji: '⚡' },
  { id: 'copy', label: 'AI copy', emoji: '✨' },
] as const;
type Tab = (typeof TABS)[number]['id'];

/**
 * The staff area. Hidden from customers here, and enforced by the API on every call:
 * each admin route checks the admin role inside the signed token, so hiding the link is only cosmetic.
 */
export function AdminPage() {
  const { user, loading } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as Tab) : 'overview';
  useTitle(`Admin · ${TABS.find((t) => t.id === tab)!.label}`);
  if (loading) return <Spinner />;
  if (user?.role !== 'admin') return <Navigate to="/" replace />;

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black tracking-tight">Admin</h1>
          <p className="text-sm text-slate-500">Signed in as staff: {user.email}</p>
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto rounded-2xl bg-slate-100 p-1 dark:bg-slate-900" aria-label="Admin sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setParams({ tab: t.id })}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`shrink-0 rounded-xl px-4 py-2 text-sm font-semibold transition ${
              tab === t.id ? 'bg-white shadow-sm dark:bg-slate-800' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <span aria-hidden>{t.emoji}</span> {t.label}
          </button>
        ))}
      </nav>
      {tab === 'overview' && <Overview />}
      {tab === 'orders' && <AdminOrders />}
      {tab === 'products' && <AdminProducts />}
      {tab === 'drops' && <AdminDrops />}
      {tab === 'copy' && <ProductCopy />}
    </div>
  );
}
