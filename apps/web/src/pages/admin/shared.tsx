import type { ReactNode } from 'react';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium">
      {label}
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-xs font-normal text-slate-500">{hint}</p>}
    </label>
  );
}

export function Stat({ label, value, sub, tone = 'slate' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'slate' | 'green' | 'amber' | 'rose' }) {
  const tones = {
    slate: 'from-slate-500/10 to-slate-500/0',
    green: 'from-emerald-500/15 to-emerald-500/0',
    amber: 'from-amber-500/15 to-amber-500/0',
    rose: 'from-rose-500/15 to-rose-500/0',
  };
  return (
    <div className={`card bg-linear-to-br p-5 ${tones[tone]}`}>
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-black tabular-nums">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

const STATUS_PILL = {
  pending_payment: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200',
  paid: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200',
  cancelled: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
} as const;

export function StatusPill({ status, children }: { status: keyof typeof STATUS_PILL; children: ReactNode }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_PILL[status]}`}>{children}</span>;
}

/** <input type="datetime-local"> works in local time without a zone: convert both ways. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export const fromLocalInput = (value: string) => new Date(value).toISOString();
