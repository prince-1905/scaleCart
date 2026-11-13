import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { categoryStyle } from '../lib/format';
import type { Category } from '../lib/types';

/** The product "photo": an emoji on its category's gradient (the catalog has no images). */
export function ProductArt({ category, size = 'md' }: { category: Category | null; size?: 'sm' | 'md' | 'lg' }) {
  const style = categoryStyle(category);
  const box = { sm: 'h-14 w-14 text-2xl rounded-xl', md: 'aspect-[4/3] text-5xl rounded-xl', lg: 'aspect-square text-8xl rounded-3xl' }[size];
  return (
    <div className={`relative grid place-items-center overflow-hidden bg-linear-to-br ${style.gradient} ${box}`} aria-hidden>
      <div className="absolute -right-6 -top-6 h-24 w-24 rounded-full bg-white/20 blur-xl" />
      <span className="drop-shadow-md transition-transform duration-300 group-hover:scale-110">{style.emoji}</span>
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-16 text-slate-500">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
      {label}…
    </div>
  );
}

export function EmptyState({ emoji, title, children }: { emoji: string; title: string; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-16 text-center animate-fade-up">
      <span className="text-5xl">{emoji}</span>
      <h2 className="text-lg font-semibold">{title}</h2>
      {children && <div className="text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
      <span>{message}</span>
      {onRetry && (
        <button className="font-semibold underline" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function ProductCardSkeleton() {
  return (
    <div className="card animate-pulse p-3">
      <div className="aspect-[4/3] rounded-xl bg-slate-200 dark:bg-slate-800" />
      <div className="mt-3 h-4 w-3/4 rounded bg-slate-200 dark:bg-slate-800" />
      <div className="mt-2 h-4 w-1/3 rounded bg-slate-200 dark:bg-slate-800" />
    </div>
  );
}

// ---------- toasts ----------

type ToastKind = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

const ToastContext = createContext<(text: string, kind?: ToastKind) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all.slice(-2), { id, kind, text }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 3500);
  }, []);
  const color = { success: 'bg-emerald-600', error: 'bg-rose-600', info: 'bg-slate-800' };
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div key={t.id} className={`pointer-events-auto max-w-md rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-lg animate-fade-up ${color[t.kind]}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
