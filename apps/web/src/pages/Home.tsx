import { useTitle } from '../lib/title';
import { Link } from 'react-router';
import { ProductCard } from '../components/ProductCard';
import { ErrorBox, ProductCardSkeleton } from '../components/ui';
import { errorMessage } from '../lib/api';
import { CATEGORY_STYLE } from '../lib/format';
import { useDrops, useServerNow } from '../lib/drops';
import { useProducts } from '../lib/queries';
import { DropCard } from './Drops';
import { CATEGORIES } from '../lib/types';

export function Home() {
  useTitle(undefined);
  const products = useProducts({});
  const drops = useDrops();
  const now = useServerNow(drops.data?.[0]?.serverTime);
  const spotlight = drops.data?.find((d) => d.available !== 0);

  return (
    <div className="space-y-14">
      <section className="relative overflow-hidden rounded-3xl bg-linear-to-br from-brand-600 via-violet-600 to-fuchsia-600 px-6 py-14 text-white shadow-xl sm:px-12">
        <div className="absolute -right-16 -top-16 h-64 w-64 rounded-full bg-white/10 blur-2xl" />
        <div className="absolute -bottom-24 left-1/3 h-64 w-64 rounded-full bg-fuchsia-400/30 blur-3xl" />
        <div className="relative max-w-xl animate-fade-up">
          <p className="mb-3 inline-flex rounded-full bg-white/15 px-3 py-1 text-xs font-semibold tracking-wide backdrop-blur">
            Limited drops · fair queues · instant checkout
          </p>
          <h1 className="text-4xl font-extrabold leading-tight sm:text-5xl">The drop everyone wants. A line that's actually fair.</h1>
          <p className="mt-4 text-white/85">
            Join the line before the countdown ends, get your number, and check out in seconds, even when thousands
            arrive at once.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/drops" className="btn bg-white text-brand-700 shadow-lg hover:bg-brand-50">See live drops 🔥</Link>
            <Link to="/products" className="btn bg-white/15 text-white backdrop-blur hover:bg-white/25">Browse the shop</Link>
          </div>
        </div>
      </section>

      {spotlight && (
        <section className="grid items-center gap-6 md:grid-cols-[1fr_380px]">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-rose-600">Next drop</p>
            <h2 className="mt-1 text-3xl font-extrabold">{spotlight.name}</h2>
            <p className="mt-2 text-slate-500">
              {spotlight.available} available, {spotlight.maxPerCustomer} per customer. Join the line and you'll get a number;
              numbers are called in order, so refreshing doesn't help and bots can't jump ahead.
            </p>
            <Link to="/drops" className="mt-4 inline-block text-sm font-semibold text-brand-600 hover:underline">All drops →</Link>
          </div>
          <DropCard drop={spotlight} now={now} />
        </section>
      )}

      <section>
        <h2 className="mb-4 text-xl font-bold">Shop by category</h2>
        <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
          {CATEGORIES.map((c) => (
            <Link
              key={c}
              to={`/products?category=${c}`}
              className="card group flex flex-col items-center gap-2 p-3 text-center transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <span className={`grid h-12 w-12 place-items-center rounded-xl bg-linear-to-br text-2xl ${CATEGORY_STYLE[c].gradient}`}>
                {CATEGORY_STYLE[c].emoji}
              </span>
              <span className="text-xs font-medium">{CATEGORY_STYLE[c].label}</span>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-4 flex items-end justify-between">
          <h2 className="text-xl font-bold">Fresh in</h2>
          <Link to="/products" className="text-sm font-semibold text-brand-600 hover:underline">View all →</Link>
        </div>
        {products.isError ? (
          <ErrorBox message={errorMessage(products.error)} onRetry={() => products.refetch()} />
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {products.data
              ? products.data.slice(0, 8).map((p) => <ProductCard key={p.id} product={p} />)
              : Array.from({ length: 8 }, (_, i) => <ProductCardSkeleton key={i} />)}
          </div>
        )}
      </section>
    </div>
  );
}
