import type { ApiErrorBody, Tokens } from './types';

/** An API answer that wasn't 2xx. `code` is our own error code when the API sent one (e.g. "out_of_stock"). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? `Request failed (${status})`));
  }

  get code(): string | undefined {
    return typeof this.body.error === 'string' ? this.body.error : undefined;
  }
}

/** A readable message for any error, for toasts and inline errors. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Connection problem. Please try again.';
}

// ---------- tokens ----------
// Demo trade-off: tokens live in localStorage so a reload keeps you logged in. A production shop would keep
// the refresh token in an HttpOnly cookie, out of reach of page scripts (the API would need to set it).

const STORAGE_KEY = 'scalecart.tokens';
const listeners = new Set<() => void>();

export const tokens = {
  get(): Tokens | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Tokens) : null;
    } catch {
      return null;
    }
  },
  set(value: Tokens | null) {
    try {
      if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // private mode or blocked storage: the session simply won't survive a reload
    }
    for (const listener of listeners) listener();
  },
  /** Called whenever tokens change (login, refresh, logout, or a refresh that failed). */
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

let refreshing: Promise<boolean> | null = null;

/**
 * Trades the refresh token for a new pair. Single-flight: when several requests hit an expired access token at
 * once, they all wait for ONE refresh. The API rotates refresh tokens and treats a reused one as theft
 * (it revokes the whole family), so two parallel refreshes would log the user out.
 */
function refreshTokens(): Promise<boolean> {
  refreshing ??= (async () => {
    const current = tokens.get();
    if (!current) return false;
    try {
      const res = await fetch('/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!res.ok) {
        tokens.set(null);
        return false;
      }
      tokens.set((await res.json()) as Tokens);
      return true;
    } catch {
      return false; // offline: keep the tokens, the next request can try again
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

// ---------- requests ----------

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Sent as JSON. Omitted = no body and no Content-Type (Fastify rejects an empty JSON body). */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** fetch with the access token, one automatic refresh on 401, and ApiError for non-2xx answers. */
export async function send(path: string, options: RequestOptions = {}): Promise<Response> {
  const attempt = () => {
    const headers: Record<string, string> = { ...options.headers };
    const access = tokens.get()?.accessToken;
    if (access) headers.authorization = `Bearer ${access}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  };
  let res = await attempt();
  if (res.status === 401 && tokens.get() && (await refreshTokens())) res = await attempt();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
    throw new ApiError(res.status, body);
  }
  return res;
}

/** send() and parse the JSON answer (undefined for 204 No Content). */
export async function api<T>(path: string, options?: RequestOptions): Promise<T> {
  const res = await send(path, options);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
