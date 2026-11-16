import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { api, tokens } from './api';
import type { Tokens, TwoFactorChallenge, User } from './types';

interface AuthState {
  user: User | null;
  /** True while we have tokens but haven't loaded the user yet (first paint after a reload). */
  loading: boolean;
  /** Resolves to a challenge when the account needs a 2FA code; the user is signed in otherwise. */
  login(email: string, password: string): Promise<TwoFactorChallenge | null>;
  /** Second step of a 2FA login: the challenge from login() + a code from the app (or a backup code). */
  loginWithCode(challengeToken: string, code: string): Promise<void>;
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

  const signIn = useCallback(
    async (pair: Tokens) => {
      tokens.set(pair);
      queryClient.clear(); // a different user: drop everything cached for the previous one
      await queryClient.fetchQuery({ queryKey: ['me'], queryFn: () => api<User>('/auth/me') });
    },
    [queryClient],
  );

  const start = useCallback(
    async (path: '/auth/login' | '/auth/register', email: string, password: string) => {
      const answer = await api<Tokens | TwoFactorChallenge>(path, { method: 'POST', body: { email, password } });
      if ('twoFactorRequired' in answer) return answer;
      await signIn(answer);
      return null;
    },
    [signIn],
  );

  const loginWithCode = useCallback(
    async (challengeToken: string, code: string) => {
      await signIn(await api<Tokens>('/auth/login/2fa', { method: 'POST', body: { challengeToken, code } }));
    },
    [signIn],
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
      register: async (email, password) => {
        await start('/auth/register', email, password);
      },
      loginWithCode,
      logout,
    }),
    [signedIn, me.data, me.isPending, start, loginWithCode, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
