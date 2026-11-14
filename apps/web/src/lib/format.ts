import type { Category } from './types';

/** Paise → "₹2,499" (Indian digit grouping, no trailing .00). */
export function inr(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** How each category looks: the shop has no product photos, so cards get an emoji on a colour gradient. */
export const CATEGORY_STYLE: Record<Category, { emoji: string; label: string; gradient: string }> = {
  electronics: { emoji: '🎧', label: 'Electronics', gradient: 'from-sky-400 to-indigo-500' },
  fashion: { emoji: '👕', label: 'Fashion', gradient: 'from-pink-400 to-rose-500' },
  footwear: { emoji: '👟', label: 'Footwear', gradient: 'from-amber-400 to-orange-500' },
  home: { emoji: '🛋️', label: 'Home', gradient: 'from-emerald-400 to-teal-500' },
  kitchen: { emoji: '🍳', label: 'Kitchen', gradient: 'from-lime-400 to-green-500' },
  beauty: { emoji: '💄', label: 'Beauty', gradient: 'from-fuchsia-400 to-purple-500' },
  sports: { emoji: '🏏', label: 'Sports', gradient: 'from-cyan-400 to-blue-500' },
  books: { emoji: '📚', label: 'Books', gradient: 'from-violet-400 to-indigo-600' },
};

export const OTHER_STYLE = { emoji: '🛍️', label: 'Other', gradient: 'from-slate-400 to-slate-600' };

export const categoryStyle = (category: Category | null) => (category ? CATEGORY_STYLE[category] : OTHER_STYLE);

/** "2:05:09" / "05:09" countdown text from milliseconds. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export const ORDER_STATUS_LABEL = {
  pending_payment: 'Waiting for payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
} as const;
