import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { EmptyState, ErrorBox, Spinner } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { inr, ORDER_STATUS_LABEL } from '../../lib/format';
import type { AdminOrder, AdminOrderPage, Order, OrderStatus } from '../../lib/types';
import { StatusPill } from './shared';

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export function OrderRow({ order, onOpen }: { order: AdminOrder; onOpen?: () => void }) {
  return (
    <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900/60">
      <td className="px-5 py-3">
        <button className="font-mono text-xs text-slate-500 hover:text-brand-600" onClick={onOpen} disabled={!onOpen} title={order.id}>
          {order.id.slice(0, 8)}…
        </button>
      </td>
      <td className="px-2 py-3">{order.email ?? <span className="text-slate-400">deleted user</span>}</td>
      <td className="px-2 py-3"><StatusPill status={order.status}>{ORDER_STATUS_LABEL[order.status]}</StatusPill></td>
      <td className="px-2 py-3 text-right font-semibold tabular-nums">{inr(order.totalCents)}</td>
      <td className="hidden px-5 py-3 text-right text-slate-500 sm:table-cell">{when(order.createdAt)}</td>
    </tr>
  );
}

/** Every customer's orders, newest first. Paging uses the last id seen (keyset), so page 500 is as fast as page 1. */
export function AdminOrders() {
  const [status, setStatus] = useState<OrderStatus | ''>('');
  const [open, setOpen] = useState<string | null>(null);
  const pages = useInfiniteQuery({
    queryKey: ['admin', 'orders', status],
    queryFn: ({ pageParam }) =>
      api<AdminOrderPage>(`/admin/orders?limit=25${status ? `&status=${status}` : ''}${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const orders = pages.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {(['', 'pending_payment', 'paid', 'cancelled'] as const).map((s) => (
          <button key={s || 'all'} onClick={() => setStatus(s)} className={status === s ? 'btn-primary px-4 py-1.5 text-sm' : 'btn-ghost px-4 py-1.5 text-sm'}>
            {s ? ORDER_STATUS_LABEL[s] : 'All'}
          </button>
        ))}
      </div>

      {pages.isError ? (
        <ErrorBox message={errorMessage(pages.error)} onRetry={() => pages.refetch()} />
      ) : !pages.data ? (
        <Spinner label="Loading orders" />
      ) : orders.length === 0 ? (
        <EmptyState emoji="🧾" title="No orders here yet" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-slate-500">
              <tr className="border-b border-slate-200 dark:border-slate-800">
                <th className="px-5 py-3">Order</th><th className="px-2 py-3">Customer</th><th className="px-2 py-3">Status</th>
                <th className="px-2 py-3 text-right">Total</th><th className="hidden px-5 py-3 text-right sm:table-cell">Placed</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <OrderRow key={o.id} order={o} onOpen={() => setOpen(open === o.id ? null : o.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <OrderDetail id={open} onClose={() => setOpen(null)} />}
      {pages.hasNextPage && (
        <button className="btn-ghost w-full" onClick={() => pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
          {pages.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

function OrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const order = useQuery({ queryKey: ['admin', 'order', id], queryFn: () => api<Order & { email: string | null; paymentId: string | null }>(`/admin/orders/${id}`) });
  return (
    <div className="card space-y-3 p-5 animate-fade-up">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-bold">Order <span className="font-mono text-sm">{id}</span></h3>
          {order.data && <p className="text-sm text-slate-500">{order.data.email} · {when(order.data.createdAt)}{order.data.paymentId && ` · ${order.data.paymentId}`}</p>}
        </div>
        <button className="btn-ghost px-3 py-1 text-sm" onClick={onClose} aria-label="Close order">✕</button>
      </div>
      {order.isError ? <ErrorBox message={errorMessage(order.error)} /> : !order.data ? <Spinner /> : (
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {order.data.items.map((i) => (
            <li key={i.productId} className="flex justify-between py-2">
              <span>{i.name} <span className="text-slate-500">× {i.quantity}</span></span>
              <span className="tabular-nums">{inr(i.unitPriceCents * i.quantity)}</span>
            </li>
          ))}
          <li className="flex justify-between py-2 font-bold"><span>Total</span><span className="tabular-nums">{inr(order.data.totalCents)}</span></li>
        </ul>
      )}
    </div>
  );
}
