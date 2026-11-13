import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';
import type { Cart, Category, Product, ProductPage, Sort } from './types';

export interface ProductFilters {
  q?: string;
  category?: Category;
  sort?: Sort;
  minPriceCents?: number;
  maxPriceCents?: number;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') search.set(k, String(v));
  const s = search.toString();
  return s ? `?${s}` : '';
}

/**
 * Products for the shop grid. With any filter it uses the search endpoint (best matches, max 20);
 * without, the plain newest-first list.
 */
export function useProducts(filters: ProductFilters) {
  const filtered = Boolean(filters.q || filters.category || filters.minPriceCents || filters.maxPriceCents);
  return useQuery({
    queryKey: ['products', filters],
    queryFn: () =>
      filtered || (filters.sort && filters.sort !== 'relevance')
        ? api<Product[]>(`/products/search${query({ ...filters, limit: 20 })}`)
        : api<ProductPage>(`/products${query({ limit: 20 })}`).then((page) => page.items),
    placeholderData: (previous) => previous, // keep showing old results while new ones load: no flicker
  });
}

export function useProduct(id: number) {
  return useQuery({ queryKey: ['product', id], queryFn: () => api<Product>(`/products/${id}`) });
}

export function useStock(productId: number) {
  return useQuery({
    queryKey: ['stock', productId],
    queryFn: () => api<{ productId: number; available: number }>(`/inventory/${productId}`),
    refetchInterval: 15_000,
  });
}

/** The signed-in user's cart (nothing when logged out). */
export function useCart() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['cart'], queryFn: () => api<Cart>('/cart'), enabled: Boolean(user) });
}

/** Sets a cart line's quantity (0 removes it), with the cart updated on screen right away. */
export function useSetCartQuantity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, quantity }: { productId: number; quantity: number }) =>
      api(`/cart/items/${productId}`, { method: 'PUT', body: { quantity } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['cart'] }),
  });
}

export function useClearCart() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api('/cart', { method: 'DELETE' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['cart'] }),
  });
}
