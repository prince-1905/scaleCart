import { useTitle } from '../lib/title';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ProductCard } from '../components/ProductCard';
import { EmptyState, ErrorBox, ProductCardSkeleton } from '../components/ui';
import { errorMessage } from '../lib/api';
import { CATEGORY_STYLE } from '../lib/format';
import { useProducts } from '../lib/queries';
import { CATEGORIES, SORTS, type Category, type Sort } from '../lib/types';

const SORT_LABEL: Record<Sort, string> = {
  relevance: 'Best match',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
  newest: 'Newest',
};

/** The filters live in the address bar (?q=&category=&sort=), so a filtered view can be shared or bookmarked. */
export function Shop() {
  useTitle('Shop');
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const category = (CATEGORIES as readonly string[]).includes(params.get('category') ?? '') ? (params.get('category') as Category) : undefined;
  const sort = (SORTS as readonly string[]).includes(params.get('sort') ?? '') ? (params.get('sort') as Sort) : 'relevance';

  // Typing updates the box at once but the search only after a 300 ms pause: one request, not one per key.
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    const t = setTimeout(() => update({ q: text.trim() || undefined }), 300);
    return () => clearTimeout(t);
  }, [text]);

  function update(changes: Record<string, string | undefined>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }

  const products = useProducts({ q: q || undefined, category, sort });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">🔍</span>
          <input
            className="input pl-10"
            placeholder="Search running shoes, headphones…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Search products"
          />
        </div>
        <select className="input sm:w-56" value={sort} onChange={(e) => update({ sort: e.target.value === 'relevance' ? undefined : e.target.value })} aria-label="Sort">
          {SORTS.map((s) => (
            <option key={s} value={s}>{SORT_LABEL[s]}</option>
          ))}
        </select>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        <Chip active={!category} onClick={() => update({ category: undefined })}>All</Chip>
        {CATEGORIES.map((c) => (
          <Chip key={c} active={category === c} onClick={() => update({ category: c })}>
            {CATEGORY_STYLE[c].emoji} {CATEGORY_STYLE[c].label}
          </Chip>
        ))}
      </div>

      {products.isError ? (
        <ErrorBox message={errorMessage(products.error)} onRetry={() => products.refetch()} />
      ) : products.data && products.data.length === 0 ? (
        <EmptyState emoji="🔎" title="Nothing matches that">Try fewer words or another category.</EmptyState>
      ) : (
        <div className={`grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 transition-opacity ${products.isPlaceholderData ? 'opacity-60' : ''}`}>
          {products.data
            ? products.data.map((p) => <ProductCard key={p.id} product={p} />)
            : Array.from({ length: 8 }, (_, i) => <ProductCardSkeleton key={i} />)}
        </div>
      )}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
        active
          ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
          : 'border-slate-300 bg-white text-slate-700 hover:border-brand-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
      }`}
    >
      {children}
    </button>
  );
}
