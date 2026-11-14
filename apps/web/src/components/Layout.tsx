import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { useCart } from '../lib/queries';
import { ChatWidget } from './ChatWidget';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-2 text-sm font-medium transition ${
    isActive ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-100' : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
  }`;

export function Layout() {
  const { user, logout } = useAuth();
  const cart = useCart();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const count = cart.data?.items.reduce((n, i) => n + i.quantity, 0) ?? 0;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/80 backdrop-blur-lg dark:border-slate-800 dark:bg-slate-950/80">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 text-lg font-extrabold tracking-tight">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-linear-to-br from-brand-500 to-fuchsia-500 text-white">S</span>
            <span className="bg-linear-to-r from-brand-600 to-fuchsia-500 bg-clip-text text-transparent">ScaleCart</span>
          </Link>
          <nav className="hidden items-center gap-1 sm:flex">
            <NavLink to="/products" className={navClass}>Shop</NavLink>
            <NavLink to="/drops" className={navClass}>Drops 🔥</NavLink>
            {user && <NavLink to="/orders" className={navClass}>Orders</NavLink>}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link to="/cart" className="btn-ghost relative px-3" aria-label={`Cart, ${count} items`}>
              <span className="text-lg">🛒</span>
              {count > 0 && (
                <span key={count} className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-brand-600 px-1 text-xs font-bold text-white animate-pop">
                  {count}
                </span>
              )}
            </Link>
            {user ? (
              <div className="relative">
                <button className="btn-ghost" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen}>
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-100 text-xs font-bold uppercase text-brand-700">
                    {user.email[0]}
                  </span>
                  <span className="hidden max-w-36 truncate md:inline">{user.email}</span>
                </button>
                {menuOpen && (
                  <div className="card absolute right-0 mt-2 w-48 p-1 animate-fade-up" onClick={() => setMenuOpen(false)}>
                    <Link to="/orders" className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">My orders</Link>
                    {user.role === 'admin' && (
                      <Link to="/admin" className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">Admin</Link>
                    )}
                    <button
                      className="block w-full rounded-lg px-3 py-2 text-left text-sm text-rose-600 hover:bg-slate-100 dark:hover:bg-slate-800"
                      onClick={async () => {
                        await logout();
                        navigate('/');
                      }}
                    >
                      Log out
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <Link to="/login" className="btn-primary">Log in</Link>
            )}
          </div>
        </div>
        <nav className="flex gap-1 px-4 pb-2 sm:hidden">
          <NavLink to="/products" className={navClass}>Shop</NavLink>
          <NavLink to="/drops" className={navClass}>Drops 🔥</NavLink>
          {user && <NavLink to="/orders" className={navClass}>Orders</NavLink>}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Outlet />
      </main>

      <ChatWidget />

      <footer className="border-t border-slate-200 py-6 text-center text-xs text-slate-500 dark:border-slate-800">
        ScaleCart · a system-design portfolio project · payments in Razorpay test mode, no real money
      </footer>
    </div>
  );
}
