import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ErrorBox, Spinner } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { inr } from '../../lib/format';
import type { AdminOrderPage, OrderStats } from '../../lib/types';
import { Stat } from './shared';
import { OrderRow } from './AdminOrders';

export function Overview() {
  const stats = useQuery({ queryKey: ['admin', 'stats'], queryFn: () => api<OrderStats>('/admin/orders/stats'), refetchInterval: 10_000 });
  const recent = useQuery({ queryKey: ['admin', 'orders', 'recent'], queryFn: () => api<AdminOrderPage>('/admin/orders?limit=8'), refetchInterval: 10_000 });

  if (stats.isError) return <ErrorBox message={errorMessage(stats.error)} onRetry={() => stats.refetch()} />;
  if (!stats.data) return <Spinner label="Loading the numbers" />;
  const { paid, pending_payment: pending, cancelled } = stats.data.byStatus;
  const all24h = paid.orders24h + pending.orders24h + cancelled.orders24h;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat tone="green" label="Revenue (paid)" value={inr(paid.totalCents)} sub={`${inr(paid.totalCents24h)} in the last 24 h`} />
        <Stat tone="green" label="Paid orders" value={paid.orders.toLocaleString('en-IN')} sub={`${paid.orders24h} in the last 24 h`} />
        <Stat tone="amber" label="Waiting for payment" value={pending.orders.toLocaleString('en-IN')} sub={`${inr(pending.totalCents)} on hold · expires after 15 min`} />
        <Stat tone="rose" label="Cancelled" value={cancelled.orders.toLocaleString('en-IN')} sub={`${all24h} orders placed in the last 24 h`} />
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <h2 className="font-bold">Latest orders</h2>
          <Link to="/admin?tab=orders" className="text-sm font-semibold text-brand-600 hover:underline">All orders →</Link>
        </div>
        {recent.data ? (
          <table className="w-full text-sm">
            <tbody>{recent.data.items.map((o) => <OrderRow key={o.id} order={o} />)}</tbody>
          </table>
        ) : (
          <div className="p-5"><Spinner /></div>
        )}
      </div>
      <p className="text-xs text-slate-500">Refreshes every 10 s. Revenue counts paid orders only; money is stored in paise and only ever read from MySQL.</p>
    </div>
  );
}
