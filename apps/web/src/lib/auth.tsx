import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { api, tokens } from './api';
import type { Tokens, User } from './types';

interface AuthState {
  user: User | null;
  /** True while we have tokens but haven't loaded the user yet (first paint after a reload). */
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  register(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const hasTokens = () => tokens.get() !== null;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // Re-renders when tokens change anywhere, including a failed refresh inside the API client.
  const signedIn = useSyncExternalStore(tokens.subscribe, hasTokens, hasTokens);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<User>('/auth/me'),
    enabled: signedIn,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const start = useCallback(
    async (path: '/auth/login' | '/auth/register', email: string, password: string) => {
      const pair = await api<Tokens>(path, { method: 'POST', body: { email, password } });
      tokens.set(pair);
      queryClient.clear(); // a different user: drop everything cached for the previous one
      await queryClient.fetchQuery({ queryKey: ['me'], queryFn: () => api<User>('/auth/me') });
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    const current = tokens.get();
    tokens.set(null);
    queryClient.clear();
    // Revoke the refresh token on the server too; ignore failures (we're logged out locally anyway).
    if (current) await api('/auth/logout', { method: 'POST', body: { refreshToken: current.refreshToken } }).catch(() => {});
  }, [queryClient]);

  const value = useMemo<AuthState>(
    () => ({
      user: signedIn ? (me.data ?? null) : null,
      loading: signedIn && me.isPending,
      login: (email, password) => start('/auth/login', email, password),
      register: (email, password) => start('/auth/register', email, password),
      logout,
    }),
    [signedIn, me.data, me.isPending, start, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
