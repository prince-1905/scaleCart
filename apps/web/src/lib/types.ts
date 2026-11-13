/** Shapes the ScaleCart API returns (see apps/api). Money is always in paise (integer "cents"). */

export interface Product {
  id: number;
  sku: string;
  name: string;
  description: string;
  category: Category | null;
  priceCents: number;
}

export interface ProductPage {
  items: Product[];
  nextAfter: number | null;
}

export const CATEGORIES = ['electronics', 'fashion', 'footwear', 'home', 'kitchen', 'beauty', 'sports', 'books'] as const;
export type Category = (typeof CATEGORIES)[number];

export const SORTS = ['relevance', 'price_asc', 'price_desc', 'newest'] as const;
export type Sort = (typeof SORTS)[number];

export interface User {
  id: string;
  email: string;
  role: 'customer' | 'admin';
  createdAt: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface CartItem {
  productId: number;
  sku: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface Cart {
  items: CartItem[];
  totalCents: number;
}

export type OrderStatus = 'pending_payment' | 'paid' | 'cancelled';

export interface Order {
  id: string;
  status: OrderStatus;
  totalCents: number;
  items: { productId: number; sku: string; name: string; unitPriceCents: number; quantity: number }[];
  createdAt: string;
}

export interface OrderSummary {
  id: string;
  status: OrderStatus;
  totalCents: number;
  createdAt: string;
}

export interface OrderPage {
  items: OrderSummary[];
  nextBefore: string | null;
}

export interface PaymentSession {
  orderId: string;
  provider: 'razorpay';
  keyId: string;
  providerOrderId: string;
  amountPaise: number;
  currency: string;
  expiresAt: string;
}

export interface Drop {
  id: number;
  name: string;
  status: 'upcoming' | 'live';
  startsAt: string;
  maxPerCustomer: number;
  admitPerSecond: number;
  maxShoppers: number | null;
  product: { id: number; name: string; priceCents: number; category: Category | null };
  available: number | null;
  serverTime: string;
}

export interface QueueStatus {
  dropId: number;
  ticket: number;
  admittedUpTo: number;
  position: number;
  etaSeconds: number;
  admitted: boolean;
  pass?: string;
  passExpiresAt?: string;
  /** The line is closed: nothing left to try for (it reopens if unpaid orders expire). */
  soldOut?: boolean;
}

/** Error bodies: Nest's `{ statusCode, message }`, plus our own `error` codes (out_of_stock, drop_not_started…). */
export interface ApiErrorBody {
  statusCode?: number;
  error?: string;
  message?: string | string[];
  [key: string]: unknown;
}

// ---------- admin ----------

export interface AdminOrder extends OrderSummary {
  userId: string;
  email: string | null;
  paymentId: string | null;
}

export interface AdminOrderPage {
  items: AdminOrder[];
  nextBefore: string | null;
}

export interface StatusTotals {
  orders: number;
  totalCents: number;
  orders24h: number;
  totalCents24h: number;
}

export interface OrderStats {
  byStatus: Record<OrderStatus, StatusTotals>;
}

/** The admin's live view of one drop. Line numbers are null when Redis can't answer. */
export interface DropStats {
  dropId: number;
  ticketsIssued: number | null;
  calledUpTo: number | null;
  /** "One out, one in" drops only: buyers holding a place right now. */
  shopping: number | null;
  inLine: number | null;
  purchases: number;
  available: number | null;
  /** The Redis door counter (stock gate); null when not set. */
  gateCounter: number | null;
  serverTime: string;
}
