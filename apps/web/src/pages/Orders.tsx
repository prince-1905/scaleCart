import { useTitle } from '../lib/title';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { EmptyState, ErrorBox, Spinner, useToast } from '../components/ui';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { countdown, inr, ORDER_STATUS_LABEL } from '../lib/format';
import { payForOrder } from '../lib/razorpay';
import type { Order, OrderPage, OrderStatus } from '../lib/types';

const PAYMENT_WINDOW_MS = 15 * 60_000; // the API cancels unpaid orders after 15 minutes

const STATUS_STYLE: Record<OrderStatus, string> = {
  pending_payment: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  paid: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  cancelled: 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_STYLE[status]}`}>{ORDER_STATUS_LABEL[status]}</span>;
}

export function OrdersPage() {
  useTitle('Your orders');
  const orders = useQuery({ queryKey: ['orders'], queryFn: () => api<OrderPage>('/orders?limit=20') });

  if (orders.isPending) return <Spinner label="Loading your orders" />;
  if (orders.isError) return <ErrorBox message={errorMessage(orders.error)} onRetry={() => orders.refetch()} />;
  if (orders.data.items.length === 0) {
    return (
      <EmptyState emoji="📦" title="No orders yet">
        <Link to="/products" className="btn-primary mt-2">Find something you like</Link>
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3 animate-fade-up">
      <h1 className="text-2xl font-bold">Your orders</h1>
      {orders.data.items.map((o) => (
        <Link key={o.id} to={`/orders/${o.id}`} className="card flex items-center justify-between gap-4 p-4 transition hover:shadow-md">
          <div>
            <p className="font-semibold">Order #{o.id.slice(-6)}</p>
            <p className="text-sm text-slate-500">{new Date(o.createdAt).toLocaleString()}</p>
          </div>
          <div className="flex items-center gap-4">
            <StatusBadge status={o.status} />
            <span className="w-24 text-right font-bold">{inr(o.totalCents)}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}

/** What our API's payment callback put in the address after Razorpay (?payment=paid|processing|failed|…). */
const RESULT_TEXT: Record<string, { text: string; tone: 'good' | 'wait' | 'bad' }> = {
  paid: { text: 'Payment received. Your order is confirmed! 🎉', tone: 'good' },
  duplicate: { text: 'Payment received. Your order is confirmed! 🎉', tone: 'good' },
  processing: { text: 'Payment received by Razorpay, confirming with them…', tone: 'wait' },
  refund: { text: 'This order had already expired or been paid, so your money is being refunded.', tone: 'bad' },
  failed: { text: 'The payment did not go through.', tone: 'bad' },
  error: { text: "We couldn't verify the payment. If money was taken, it will be settled automatically.", tone: 'bad' },
};

export function OrderPage() {
  useTitle('Order');
  const id = useParams().id!;
  const [params, setParams] = useSearchParams();
  const result = params.get('payment');
  const { user } = useAuth();
  const toast = useToast();
  const [paying, setPaying] = useState(false);

  const order = useQuery({
    queryKey: ['order', id],
    queryFn: () => api<Order>(`/orders/${id}`),
    // Just back from Razorpay and not settled yet: ask every 2 s, the webhook usually lands within seconds.
    refetchInterval: (q) => (result && q.state.data?.status === 'pending_payment' ? 2000 : false),
  });

  // Tick once a second for the "pay within mm:ss" countdown.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (order.isPending) return <Spinner label="Loading the order" />;
  if (order.isError) {
    if (order.error instanceof ApiError && order.error.status === 404) return <EmptyState emoji="🫥" title="Order not found" />;
    return <ErrorBox message={errorMessage(order.error)} onRetry={() => order.refetch()} />;
  }

  const o = order.data;
  const msLeft = Date.parse(o.createdAt) + PAYMENT_WINDOW_MS - now;
  const banner = result ? RESULT_TEXT[result] : undefined;
  const settled = o.status === 'paid' && banner?.tone !== 'bad';
  const shown = settled ? RESULT_TEXT.paid : banner;

  async function pay() {
    setPaying(true);
    try {
      await payForOrder(o.id, user?.email);
    } catch (err) {
      setPaying(false);
      toast(errorMessage(err), 'error');
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 animate-fade-up">
      {shown && (
        <div
          className={`flex items-start justify-between gap-4 rounded-2xl px-5 py-4 font-medium ${
            { good: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200', wait: 'bg-sky-50 text-sky-800 dark:bg-sky-500/10 dark:text-sky-200', bad: 'bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-200' }[shown.tone]
          }`}
        >
          <span>
            {shown.text}
            {result === 'failed' && params.get('reason') && <span className="block text-sm opacity-80">{params.get('reason')}</span>}
          </span>
          <button className="text-sm opacity-60 hover:opacity-100" onClick={() => setParams({}, { replace: true })} aria-label="Dismiss">✕</button>
        </div>
      )}

      <div className="card p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Order #{o.id.slice(-6)}</h1>
            <p className="text-sm text-slate-500">{new Date(o.createdAt).toLocaleString()}</p>
          </div>
          <StatusBadge status={o.status} />
        </div>
        <ul className="mt-6 divide-y divide-slate-200 dark:divide-slate-800">
          {o.items.map((i) => (
            <li key={i.productId} className="flex justify-between py-3 text-sm">
              <Link to={`/products/${i.productId}`} className="hover:text-brand-600">{i.name} × {i.quantity}</Link>
              <span className="font-semibold">{inr(i.unitPriceCents * i.quantity)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-between border-t border-slate-200 pt-4 text-lg font-bold dark:border-slate-800">
          <span>Total</span>
          <span>{inr(o.totalCents)}</span>
        </div>

        {o.status === 'pending_payment' && (
          <div className="mt-6 flex flex-col items-center gap-2">
            <button className="btn-primary w-full py-3" onClick={pay} disabled={paying || msLeft < 60_000}>
              {paying ? 'Opening Razorpay…' : `Pay ${inr(o.totalCents)}`}
            </button>
            <p className="text-xs text-slate-500">
              {msLeft > 0 ? `Your items are held for ${countdown(msLeft)}. After that the order is cancelled.` : 'Payment time is up; the order will be cancelled.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
