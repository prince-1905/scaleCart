import { Link, useNavigate } from 'react-router';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { categoryStyle, inr } from '../lib/format';
import { useSetCartQuantity, useCart } from '../lib/queries';
import type { Product } from '../lib/types';
import { ProductArt, useToast } from './ui';

export function ProductCard({ product }: { product: Product }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const cart = useCart();
  const setQuantity = useSetCartQuantity();
  const inCart = cart.data?.items.find((i) => i.productId === product.id)?.quantity ?? 0;

  const add = () => {
    if (!user) return navigate(`/login?next=/products/${product.id}`);
    setQuantity.mutate(
      { productId: product.id, quantity: inCart + 1 },
      {
        onSuccess: () => toast(`Added ${product.name}`, 'success'),
        onError: (err) => toast(errorMessage(err), 'error'),
      },
    );
  };

  return (
    <article className="card group flex flex-col p-3 transition hover:-translate-y-0.5 hover:shadow-lg animate-fade-up">
      <Link to={`/products/${product.id}`} className="flex flex-1 flex-col">
        <ProductArt category={product.category} />
        <p className="mt-3 text-xs font-medium uppercase tracking-wide text-slate-500">{categoryStyle(product.category).label}</p>
        <h3 className="mt-0.5 line-clamp-2 font-semibold leading-snug">{product.name}</h3>
      </Link>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-lg font-bold">{inr(product.priceCents)}</span>
        <button className="btn-primary px-3 py-2" onClick={add} disabled={setQuantity.isPending} aria-label={`Add ${product.name} to cart`}>
          {inCart > 0 ? `In cart · ${inCart}` : 'Add'}
        </button>
      </div>
    </article>
  );
}
