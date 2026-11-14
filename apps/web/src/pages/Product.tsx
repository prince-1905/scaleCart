import { useTitle } from '../lib/title';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { EmptyState, ErrorBox, ProductArt, Spinner, useToast } from '../components/ui';
import { ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { categoryStyle, inr } from '../lib/format';
import { useCart, useProduct, useSetCartQuantity, useStock } from '../lib/queries';

const MAX_PER_LINE = 10; // the API's per-line limit

export function ProductPage() {
  const id = Number(useParams().id);
  const product = useProduct(id);
  useTitle(product.data?.name);
  const stock = useStock(id);
  const cart = useCart();
  const setQuantity = useSetCartQuantity();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [quantity, setQty] = useState(1);

  if (product.isPending) return <Spinner />;
  if (product.isError) {
    if (product.error instanceof ApiError && product.error.status === 404) {
      return (
        <EmptyState emoji="🫥" title="We couldn't find that product">
          <Link to="/products" className="font-semibold text-brand-600 hover:underline">Back to the shop</Link>
        </EmptyState>
      );
    }
    return <ErrorBox message={errorMessage(product.error)} onRetry={() => product.refetch()} />;
  }

  const p = product.data;
  const available = stock.data?.available;
  const inCart = cart.data?.items.find((i) => i.productId === p.id)?.quantity ?? 0;
  const soldOut = available === 0;
  const maxNow = Math.min(MAX_PER_LINE - inCart, available ?? MAX_PER_LINE);

  const add = () => {
    if (!user) return navigate(`/login?next=/products/${p.id}`);
    setQuantity.mutate(
      { productId: p.id, quantity: inCart + quantity },
      {
        onSuccess: () => toast(`Added ${quantity} × ${p.name}`, 'success'),
        onError: (err) => toast(errorMessage(err), 'error'),
      },
    );
  };

  return (
    <div className="grid gap-10 md:grid-cols-2 animate-fade-up">
      <div className="group">
        <ProductArt category={p.category} size="lg" />
      </div>
      <div className="flex flex-col">
        <Link to={`/products?category=${p.category ?? ''}`} className="text-sm font-semibold uppercase tracking-wide text-brand-600">
          {categoryStyle(p.category).label}
        </Link>
        <h1 className="mt-2 text-3xl font-extrabold leading-tight">{p.name}</h1>
        <p className="mt-4 text-3xl font-bold">{inr(p.priceCents)}</p>

        <div className="mt-3">
          {available === undefined ? null : soldOut ? (
            <span className="rounded-full bg-rose-100 px-3 py-1 text-sm font-semibold text-rose-700">Sold out</span>
          ) : available <= 5 ? (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-800">Only {available} left!</span>
          ) : (
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-700">In stock</span>
          )}
        </div>

        <p className="mt-6 whitespace-pre-line leading-relaxed text-slate-600 dark:text-slate-300">{p.description || 'No description yet.'}</p>

        <div className="mt-8 flex items-center gap-3">
          <div className="flex items-center rounded-xl border border-slate-300 dark:border-slate-700">
            <button className="px-3 py-2 text-lg" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Fewer">−</button>
            <span className="w-8 text-center font-semibold" aria-live="polite">{quantity}</span>
            <button className="px-3 py-2 text-lg" onClick={() => setQty((q) => Math.min(Math.max(1, maxNow), q + 1))} aria-label="More">+</button>
          </div>
          <button className="btn-primary flex-1 py-3" onClick={add} disabled={soldOut || maxNow < 1 || setQuantity.isPending}>
            {soldOut ? 'Sold out' : maxNow < 1 ? 'Limit reached' : 'Add to cart'}
          </button>
        </div>
        {inCart > 0 && (
          <Link to="/cart" className="mt-3 text-sm font-semibold text-brand-600 hover:underline">
            {inCart} in your cart → Go to cart
          </Link>
        )}
      </div>
    </div>
  );
}
