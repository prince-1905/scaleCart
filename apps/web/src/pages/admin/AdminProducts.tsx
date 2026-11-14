import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorBox, ProductArt, Spinner, useToast } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { CATEGORY_STYLE, inr } from '../../lib/format';
import { CATEGORIES, type Category, type Product } from '../../lib/types';
import { Field } from './shared';

const rupeesToPaise = (value: string) => Math.round(Number(value) * 100);

/** Newest 20 products, or the best 20 matches for a search (the search endpoint caps at 20). "#123" opens one id. */
function useAdminProducts(q: string) {
  return useQuery({
    queryKey: ['admin', 'products', q],
    queryFn: async () => {
      const id = /^#?(\d+)$/.exec(q.trim())?.[1];
      const products = id
        ? [await api<Product>(`/products/${id}`)]
        : await api<Product[]>(`/products/search?sort=${q ? 'relevance' : 'newest'}&limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      // One call for every row's stock instead of 20 (GET /inventory?productIds=…).
      const stock = products.length
        ? await api<{ items: { productId: number; available: number }[] }>(`/inventory?productIds=${products.map((p) => p.id).join(',')}`)
        : { items: [] };
      const available = new Map(stock.items.map((s) => [s.productId, s.available]));
      return products.map((p) => ({ ...p, available: available.get(p.id) ?? null }));
    },
    placeholderData: (previous) => previous,
  });
}

export function AdminProducts() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const products = useAdminProducts(q);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); setQ(search.trim()); }}>
          <input className="input" placeholder="Search by name, or #id" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search products" />
          <button className="btn-ghost shrink-0">Search</button>
        </form>
        <button className="btn-primary shrink-0" onClick={() => setEditing('new')}>+ New product</button>
      </div>

      {editing === 'new' && <ProductForm onDone={() => setEditing(null)} />}

      {products.isError ? (
        <ErrorBox message={errorMessage(products.error)} onRetry={() => products.refetch()} />
      ) : !products.data ? (
        <Spinner label="Loading products" />
      ) : products.data.length === 0 ? (
        <EmptyState emoji="📦" title="No products match" />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {products.data.map((p) =>
            editing === p.id ? (
              <div key={p.id} className="p-4"><ProductForm product={p} onDone={() => setEditing(null)} /></div>
            ) : (
              <div key={p.id} className="flex items-center gap-4 p-4">
                <ProductArt category={p.category} size="sm" />
                <div className="min-w-0 flex-1">
                  <Link to={`/products/${p.id}`} className="line-clamp-1 font-semibold hover:text-brand-600">{p.name}</Link>
                  <p className="text-xs text-slate-500">#{p.id} · {p.sku} · {p.category ? CATEGORY_STYLE[p.category].label : 'No category'}</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold tabular-nums">{inr(p.priceCents)}</p>
                  <p className={`text-xs ${p.available === 0 ? 'font-semibold text-rose-600' : 'text-slate-500'}`}>
                    {p.available === null ? 'no stock row' : p.available === 0 ? 'out of stock' : `${p.available} in stock`}
                  </p>
                </div>
                <button className="btn-ghost px-3 py-1.5 text-sm" onClick={() => setEditing(p.id)}>Edit</button>
              </div>
            ),
          )}
        </div>
      )}
      <p className="text-xs text-slate-500">Shows the newest 20 (search finds any of the catalog). Price and name changes reach the shop's cache within its TTL; past orders keep the price they were bought at.</p>
    </div>
  );
}

/** Create (no product) or edit. Stock is a separate module and call: PUT /inventory/:id. */
function ProductForm({ product, onDone }: { product?: Product & { available: number | null }; onDone: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    sku: '',
    name: product?.name ?? '',
    price: product ? String(product.priceCents / 100) : '',
    category: (product?.category ?? '') as Category | '',
    description: product?.description ?? '',
    stock: product?.available === null || product === undefined ? '' : String(product.available),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = {
        name: form.name,
        priceCents: rupeesToPaise(form.price),
        description: form.description,
        ...(form.category ? { category: form.category } : {}),
      };
      const saved = product
        ? await api<Product>(`/products/${product.id}`, { method: 'PATCH', body })
        : await api<Product>('/products', { method: 'POST', body: { ...body, sku: form.sku } });
      if (form.stock !== '' && Number(form.stock) !== product?.available) {
        await api(`/inventory/${saved.id}`, { method: 'PUT', body: { available: Number(form.stock) } });
      }
      toast(product ? `Saved #${saved.id}` : `Created product #${saved.id}`, 'success');
      queryClient.invalidateQueries({ queryKey: ['admin', 'products'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['product', saved.id] });
      queryClient.invalidateQueries({ queryKey: ['stock', saved.id] });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={product ? 'space-y-3' : 'card space-y-3 p-5 animate-fade-up'} onSubmit={submit}>
      <h3 className="font-bold">{product ? `Edit #${product.id}` : 'New product'}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {!product && (
          <Field label="SKU" hint="Letters, digits and dashes, 3–64">
            <input className="input" required pattern="[A-Za-z0-9\-]{3,64}" value={form.sku} onChange={set('sku')} />
          </Field>
        )}
        <Field label="Name"><input className="input" required maxLength={200} value={form.name} onChange={set('name')} /></Field>
        <Field label="Price (₹)"><input className="input" type="number" required min={0.01} step={0.01} value={form.price} onChange={set('price')} /></Field>
        <Field label="Category">
          <select className="input" value={form.category} onChange={set('category')}>
            {!form.category && <option value="">Choose…</option>}
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_STYLE[c].emoji} {CATEGORY_STYLE[c].label}</option>)}
          </select>
        </Field>
        <Field label="Stock" hint="Units available to sell right now">
          <input className="input" type="number" min={0} max={10_000_000} value={form.stock} onChange={set('stock')} placeholder="0" />
        </Field>
      </div>
      <Field label="Description"><textarea className="input" rows={3} maxLength={5000} value={form.description} onChange={set('description')} /></Field>
      {error && <ErrorBox message={error} />}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : product ? 'Save' : 'Create'}</button>
        <button type="button" className="btn-ghost" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
