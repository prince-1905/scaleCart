import { useTitle } from '../lib/title';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { ErrorBox } from '../components/ui';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

/** Login and register share one form. `?next=/cart` brings the user back where they were. */
export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  useTitle(mode === 'login' ? 'Log in' : 'Create account');
  const { user, login, register } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next')?.startsWith('/') ? params.get('next')! : '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={next} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await (mode === 'login' ? login(email, password) : register(email, password));
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const isLogin = mode === 'login';
  return (
    <div className="mx-auto max-w-sm animate-fade-up">
      <div className="card p-8">
        <h1 className="text-2xl font-bold">{isLogin ? 'Welcome back' : 'Create your account'}</h1>
        <p className="mt-1 text-sm text-slate-500">{isLogin ? 'Log in to join drops and check out.' : 'It takes 10 seconds.'}</p>
        <form className="mt-6 space-y-4" onSubmit={submit}>
          <label className="block text-sm font-medium">
            Email
            <input className="input mt-1" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="block text-sm font-medium">
            Password
            <input
              className="input mt-1"
              type="password"
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              minLength={isLogin ? undefined : 10}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {!isLogin && <span className="mt-1 block text-xs text-slate-500">At least 10 characters.</span>}
          </label>
          {error && <ErrorBox message={error} />}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? 'Please wait…' : isLogin ? 'Log in' : 'Create account'}
          </button>
        </form>
        <p className="mt-6 text-center text-sm text-slate-500">
          {isLogin ? 'New here? ' : 'Already have an account? '}
          <Link className="font-semibold text-brand-600 hover:underline" to={`${isLogin ? '/register' : '/login'}?next=${encodeURIComponent(next)}`}>
            {isLogin ? 'Create an account' : 'Log in'}
          </Link>
        </p>
      </div>
    </div>
  );
}
