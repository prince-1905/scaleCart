import { useTitle } from '../lib/title';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { EmptyState, ErrorBox, ProductArt, Spinner, useToast } from '../components/ui';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { inr } from '../lib/format';
import { useCart, useClearCart, useProducts, useSetCartQuantity } from '../lib/queries';
import { payForOrder } from '../lib/razorpay';
import type { Order } from '../lib/types';

export function CartPage() {
  useTitle('Cart');
  const cart = useCart();
  const products = useProducts({}); // only to show each line's category art
  const setQuantity = useSetCartQuantity();
  const clear = useClearCart();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'idle' | 'ordering' | 'paying'>('idle');
  // One key per checkout attempt, reused if this attempt is retried: a double click or a retry after a
  // network error can never create two orders (the API replays the first answer).
  const checkoutKey = useRef<string | null>(null);

  if (cart.isPending) return <Spinner label="Loading your cart" />;
  if (cart.isError) return <ErrorBox message={errorMessage(cart.error)} onRetry={() => cart.refetch()} />;
  const { items, totalCents } = cart.data;
  if (items.length === 0) {
    return (
      <EmptyState emoji="🛒" title="Your cart is empty">
        <Link to="/products" className="btn-primary mt-2">Start shopping</Link>
      </EmptyState>
    );
  }

  async function checkout() {
    setError(null);
    setStep('ordering');
    checkoutKey.current ??= crypto.randomUUID();
    let order: Order;
    try {
      order = await api<Order>('/checkout', {
        method: 'POST',
        headers: { 'idempotency-key': checkoutKey.current },
        // The total the customer saw: if a price changed meanwhile, the API refuses instead of charging more.
        body: { expectedTotalCents: totalCents },
      });
    } catch (err) {
      setStep('idle');
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) checkoutKey.current = null; // a definite "no"
      if (err instanceof ApiError && err.code === 'price_changed') await cart.refetch();
      setError(errorMessage(err));
      return;
    }
    checkoutKey.current = null;
    await queryClient.invalidateQueries({ queryKey: ['cart'] });
    setStep('paying');
    try {
      await payForOrder(order.id, user?.email); // leaves the page for Razorpay
    } catch (err) {
      setStep('idle');
      toast(`Order placed, but payment couldn't start: ${errorMessage(err)}`, 'error');
      navigate(`/orders/${order.id}`);
    }
  }

  const art = new Map(products.data?.map((p) => [p.id, p.category]) ?? []);

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_340px] animate-fade-up">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Your cart</h1>
          <button className="text-sm text-slate-500 hover:text-rose-600" onClick={() => clear.mutate()} disabled={clear.isPending}>
            Empty cart
          </button>
        </div>
        {items.map((item) => (
          <div key={item.productId} className="card flex items-center gap-4 p-3">
            <Link to={`/products/${item.productId}`} className="group">
              <ProductArt category={art.get(item.productId) ?? null} size="sm" />
            </Link>
            <div className="min-w-0 flex-1">
              <Link to={`/products/${item.productId}`} className="line-clamp-1 font-semibold hover:text-brand-600">{item.name}</Link>
              <p className="text-sm text-slate-500">{inr(item.unitPriceCents)} each</p>
            </div>
            <div className="flex items-center rounded-xl border border-slate-300 dark:border-slate-700">
              {[
                { label: '−', delta: -1 },
                { label: '+', delta: +1 },
              ].map(({ label, delta }, i) => (
                <button
                  key={label}
                  className={`px-3 py-1.5 text-lg ${i === 1 ? 'order-last' : ''}`}
                  aria-label={delta < 0 ? `One fewer ${item.name}` : `One more ${item.name}`}
                  disabled={setQuantity.isPending}
                  onClick={() =>
                    setQuantity.mutate(
                      { productId: item.productId, quantity: Math.max(0, item.quantity + delta) },
                      { onError: (err) => toast(errorMessage(err), 'error') },
                    )
                  }
                >
                  {label}
                </button>
              ))}
              <span className="w-8 text-center font-semibold">{item.quantity}</span>
            </div>
            <span className="w-24 text-right font-bold">{inr(item.lineTotalCents)}</span>
          </div>
        ))}
      </section>

      <aside className="card h-fit space-y-4 p-6 lg:sticky lg:top-24">
        <h2 className="text-lg font-bold">Summary</h2>
        <div className="flex justify-between text-sm text-slate-500">
          <span>Items</span>
          <span>{items.reduce((n, i) => n + i.quantity, 0)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-200 pt-4 text-lg font-bold dark:border-slate-800">
          <span>Total</span>
          <span>{inr(totalCents)}</span>
        </div>
        {error && <ErrorBox message={error} />}
        <button className="btn-primary w-full py-3" onClick={checkout} disabled={step !== 'idle'}>
          {step === 'ordering' ? 'Placing your order…' : step === 'paying' ? 'Opening Razorpay…' : 'Checkout & pay'}
        </button>
        <p className="text-xs text-slate-500">
          Test mode: card 4100 2800 0000 1007, any future expiry, any CVV, OTP of 4+ digits. Stock is held for 15 minutes.
        </p>
      </aside>
    </div>
  );
}
