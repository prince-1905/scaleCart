import { useTitle } from '../lib/title';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { EmptyState, ErrorBox, ProductArt, Spinner, useToast } from '../components/ui';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDrops, useQueue, useServerNow } from '../lib/drops';
import { countdown, inr } from '../lib/format';
import { payForOrder } from '../lib/razorpay';
import type { Drop, Order } from '../lib/types';

export function DropsPage() {
  useTitle('Drops');
  const drops = useDrops();
  const now = useServerNow(drops.data?.[0]?.serverTime);

  if (drops.isPending) return <Spinner label="Loading drops" />;
  if (drops.isError) return <ErrorBox message={errorMessage(drops.error)} onRetry={() => drops.refetch()} />;
  if (drops.data.length === 0) {
    return (
      <EmptyState emoji="⏳" title="No drops right now">
        New limited drops appear here with a countdown. <Link to="/products" className="font-semibold text-brand-600">Browse the shop</Link> meanwhile.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-6 animate-fade-up">
      <header>
        <h1 className="text-3xl font-extrabold">Drops 🔥</h1>
        <p className="mt-1 text-slate-500">
          Limited stock, one per customer. Join the line up to 10 minutes early. Numbers are called in order, and when yours
          is called you have a few minutes to buy.
        </p>
      </header>
      <div className="grid gap-6 md:grid-cols-2">
        {drops.data.map((d) => (
          <DropCard key={d.id} drop={d} now={now} />
        ))}
      </div>
    </div>
  );
}

export function DropCard({ drop, now }: { drop: Drop; now: number }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [joined, setJoined] = useState(false);
  const queue = useQueue(drop.id, joined);
  const [buying, setBuying] = useState(false);
  const checkoutKey = useRef<string | null>(null);

  const msToStart = Date.parse(drop.startsAt) - now;
  const live = msToStart <= 0;
  const soldOut = drop.available === 0;
  const lineOpen = msToStart <= 10 * 60_000;
  const status = queue.data;

  async function buy(pass: string) {
    setBuying(true);
    try {
      // "Buy now": an order for this one item, straight from the drop. The cart is never touched, so
      // nothing else in it gets bought, and a failed attempt leaves nothing behind in it.
      // The API checks the pass, the one-per-customer rule and the stock (Redis answers "sold out" fast).
      checkoutKey.current ??= crypto.randomUUID();
      const order = await api<Order>('/checkout', {
        method: 'POST',
        headers: { 'idempotency-key': checkoutKey.current },
        body: { dropPass: pass, buyNow: { productId: drop.product.id, quantity: 1 } },
      });
      checkoutKey.current = null;
      await payForOrder(order.id, user?.email);
    } catch (err) {
      setBuying(false);
      if (err instanceof ApiError && err.status < 500) checkoutKey.current = null;
      if (err instanceof ApiError && err.code === 'drop_already_bought') {
        toast("You already have an order in this drop. Check your orders.", 'info');
      } else {
        toast(errorMessage(err), 'error');
      }
      queryClient.invalidateQueries({ queryKey: ['drops'] });
    }
  }

  return (
    <article className="card overflow-hidden">
      <div className="group relative">
        <ProductArt category={drop.product.category} />
        <span
          className={`absolute left-3 top-3 rounded-full px-3 py-1 text-xs font-bold text-white shadow ${
            soldOut ? 'bg-slate-700' : live ? 'animate-pulse bg-rose-600' : 'bg-slate-900/70 backdrop-blur'
          }`}
        >
          {soldOut ? 'SOLD OUT' : live ? '● LIVE' : 'UPCOMING'}
        </span>
      </div>
      <div className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold leading-tight">{drop.name}</h2>
            <p className="text-sm text-slate-500">
              {drop.available ?? '?'} left · max {drop.maxPerCustomer} per customer
            </p>
          </div>
          <span className="text-xl font-extrabold">{inr(drop.product.priceCents)}</span>
        </div>

        {!live && (
          <div className="rounded-xl bg-slate-900 py-4 text-center text-white dark:bg-slate-800">
            <p className="text-xs uppercase tracking-widest text-slate-400">Starts in</p>
            <p className="font-mono text-4xl font-bold tabular-nums">{countdown(msToStart)}</p>
          </div>
        )}

        {soldOut ? (
          <p className="text-center text-sm text-slate-500">All gone. Follow the next drop!</p>
        ) : !user ? (
          <button className="btn-primary w-full py-3" onClick={() => navigate('/login?next=/drops')}>Log in to join the line</button>
        ) : user.role === 'admin' ? (
          // The API refuses staff too (403 staff_cannot_join_drops); this just says so up front.
          <div className="rounded-xl bg-slate-100 p-4 text-center text-sm dark:bg-slate-800">
            <p className="font-semibold">Staff can't join drops: limited stock is for customers.</p>
            <Link to={`/admin?tab=drops&drop=${drop.id}`} className="text-brand-600 hover:underline">Watch it live in the admin area →</Link>
          </div>
        ) : !joined ? (
          <button className="btn-primary w-full py-3" onClick={() => setJoined(true)} disabled={!lineOpen}>
            {lineOpen ? 'Join the line' : 'The line opens 10 minutes before the start'}
          </button>
        ) : queue.isError && !status ? (
          <ErrorBox message={errorMessage(queue.error)} onRetry={() => queue.refetch()} />
        ) : !status ? (
          <Spinner label="Getting your number" />
        ) : status.soldOut ? (
          <div className="rounded-xl bg-slate-100 p-4 text-center text-sm dark:bg-slate-800">
            <p className="font-semibold">Sold out: the line is closed.</p>
            <p className="text-slate-500">If someone doesn't pay within 15 minutes, their unit comes back and the line reopens here.</p>
          </div>
        ) : status.admitted && status.pass ? (
          <div className="space-y-2 rounded-xl bg-emerald-50 p-4 text-center animate-fade-up dark:bg-emerald-500/10">
            <p className="font-bold text-emerald-700 dark:text-emerald-300">✅ It's your turn!</p>
            <button className="btn w-full bg-emerald-600 py-3 text-white hover:bg-emerald-700" onClick={() => buy(status.pass!)} disabled={buying}>
              {buying ? 'Placing your order…' : `Buy now · ${inr(drop.product.priceCents)}`}
            </button>
            {status.passExpiresAt && (
              <p className="text-xs text-slate-500">Your turn lasts until {new Date(status.passExpiresAt).toLocaleTimeString()}</p>
            )}
          </div>
        ) : (
          <QueuePosition ticket={status.ticket} position={status.position} etaSeconds={status.etaSeconds} />
        )}
      </div>
    </article>
  );
}

function QueuePosition({ ticket, position, etaSeconds }: { ticket: number; position: number; etaSeconds: number }) {
  return (
    <div className="flex items-center gap-4 rounded-xl bg-brand-50 p-4 dark:bg-brand-500/10">
      <div className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-brand-600 text-white shadow-lg shadow-brand-600/30">
        <span className="text-[10px] uppercase opacity-80">Ticket</span>
        <span className="-mt-2 text-xl font-extrabold">#{ticket}</span>
      </div>
      <div>
        <p className="font-semibold">{position === 0 ? 'Almost there…' : `${position.toLocaleString()} ahead of you`}</p>
        <p className="text-sm text-slate-500">About {etaSeconds < 60 ? `${etaSeconds} s` : `${Math.ceil(etaSeconds / 60)} min`} · don't close this page</p>
      </div>
    </div>
  );
}
