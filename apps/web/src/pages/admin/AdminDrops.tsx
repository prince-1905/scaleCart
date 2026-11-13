import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState, ErrorBox, ProductArt, Spinner, useToast } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useDrops, useServerNow } from '../../lib/drops';
import { countdown, inr } from '../../lib/format';
import type { Drop, DropStats } from '../../lib/types';
import { Field, Stat, fromLocalInput, toLocalInput } from './shared';

export function AdminDrops() {
  const drops = useDrops();
  const now = useServerNow(drops.data?.[0]?.serverTime);
  const [params, setParams] = useSearchParams();
  const selected = Number(params.get('drop')) || null;
  const select = (id: number | null) => setParams(id ? { tab: 'drops', drop: String(id) } : { tab: 'drops' });
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500">Upcoming drops and those that started in the last 24 h.</p>
        <button className="btn-primary shrink-0" onClick={() => setCreating((c) => !c)}>{creating ? 'Close' : '+ New drop'}</button>
      </div>
      {creating && <DropForm onDone={(id) => { setCreating(false); if (id) select(id); }} />}

      {drops.isError ? (
        <ErrorBox message={errorMessage(drops.error)} onRetry={() => drops.refetch()} />
      ) : !drops.data ? (
        <Spinner label="Loading drops" />
      ) : drops.data.length === 0 ? (
        <EmptyState emoji="⚡" title="No drops yet">Create one to see the live monitor.</EmptyState>
      ) : (
        <div className="space-y-3">
          {drops.data.map((d) => (
            <div key={d.id} className="card overflow-hidden">
              <button className="flex w-full items-center gap-4 p-4 text-left hover:bg-slate-50 dark:hover:bg-slate-900/60" onClick={() => select(selected === d.id ? null : d.id)} aria-expanded={selected === d.id}>
                <ProductArt category={d.product.category} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 font-semibold">{d.name}</p>
                  <p className="text-xs text-slate-500">
                    #{d.id} · product #{d.product.id} · {inr(d.product.priceCents)} · {d.maxShoppers ? `max ${d.maxShoppers} shopping` : `${d.admitPerSecond}/s`}
                  </p>
                </div>
                <DropBadge drop={d} now={now} />
              </button>
              {selected === d.id && <DropPanel drop={d} onGone={() => select(null)} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DropBadge({ drop, now }: { drop: Drop; now: number }) {
  const ms = Date.parse(drop.startsAt) - now;
  if (drop.available === 0) return <span className="rounded-full bg-slate-200 px-3 py-1 text-xs font-bold dark:bg-slate-700">SOLD OUT</span>;
  if (ms <= 0) return <span className="animate-pulse rounded-full bg-rose-600 px-3 py-1 text-xs font-bold text-white">● LIVE</span>;
  return <span className="rounded-full bg-slate-900 px-3 py-1 font-mono text-xs font-bold text-white tabular-nums">{countdown(ms)}</span>;
}

/** Live monitor + edit + cancel for one drop. */
function DropPanel({ drop, onGone }: { drop: Drop; onGone: () => void }) {
  const [editing, setEditing] = useState(false);
  const toast = useToast();
  const queryClient = useQueryClient();
  const stats = useQuery({ queryKey: ['admin', 'drop-stats', drop.id], queryFn: () => api<DropStats>(`/drops/${drop.id}/stats`), refetchInterval: 2000 });

  async function cancel() {
    if (!confirm(`Cancel "${drop.name}"? This can't be undone.`)) return;
    try {
      await api(`/drops/${drop.id}`, { method: 'DELETE' });
      toast('Drop cancelled', 'success');
      queryClient.invalidateQueries({ queryKey: ['drops'] });
      onGone();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  return (
    <div className="space-y-4 border-t border-slate-200 p-4 dark:border-slate-800">
      {editing ? <DropForm drop={drop} onDone={() => setEditing(false)} /> : <Monitor stats={stats.data} error={stats.error} drop={drop} />}
      {!editing && (
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost px-4 py-1.5 text-sm" onClick={() => setEditing(true)}>Edit</button>
          <button className="btn-ghost px-4 py-1.5 text-sm text-rose-600" onClick={cancel} disabled={(stats.data?.purchases ?? 0) > 0} title={(stats.data?.purchases ?? 0) > 0 ? 'Customers already bought in this drop' : undefined}>
            Cancel drop
          </button>
        </div>
      )}
    </div>
  );
}

function Monitor({ stats, error, drop }: { stats?: DropStats; error: unknown; drop: Drop }) {
  if (error && !stats) return <ErrorBox message={errorMessage(error)} />;
  if (!stats) return <Spinner label="Reading the line" />;
  const total = stats.purchases + (stats.available ?? 0);
  const soldPct = total ? Math.round((stats.purchases / total) * 100) : 0;
  const n = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-IN'));

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 flex justify-between text-xs font-semibold text-slate-500">
          <span>{stats.purchases} sold</span><span>{n(stats.available)} left</span>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800" role="progressbar" aria-valuenow={soldPct} aria-valuemin={0} aria-valuemax={100} aria-label="Sold">
          <div className="h-full rounded-full bg-linear-to-r from-brand-500 to-rose-500 transition-all duration-700" style={{ width: `${soldPct}%` }} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Waiting in line" value={n(stats.inLine)} sub={`${n(stats.ticketsIssued)} tickets handed out`} tone="amber" />
        <Stat label="Called" value={n(stats.calledUpTo)} sub={drop.maxShoppers ? `${n(stats.shopping)} of ${drop.maxShoppers} places in use` : `${drop.admitPerSecond} called per second`} />
        <Stat label="Purchases" value={n(stats.purchases)} sub="orders placed (paid or waiting)" tone="green" />
        <Stat label="Door counter" value={n(stats.gateCounter)} sub="Redis stock gate (MySQL decides)" tone="rose" />
      </div>
      <p className="text-xs text-slate-500">
        Live: every 2 s. "Waiting" and "called" come from Redis; purchases and stock from MySQL. An unpaid order frees its unit after 15 min.
      </p>
    </div>
  );
}

/** Create (no drop) or edit. Times are typed in local time and sent as UTC. */
function DropForm({ drop, onDone }: { drop?: Drop; onDone: (createdId?: number) => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    productId: drop ? String(drop.product.id) : '',
    name: drop?.name ?? '',
    startsAt: toLocalInput(drop?.startsAt ?? new Date(Date.now() + 2 * 60_000).toISOString()),
    max: String(drop?.maxPerCustomer ?? 1),
    mode: drop?.maxShoppers ? 'window' : 'rate',
    rate: String(drop?.admitPerSecond ?? 50),
    shoppers: String(drop?.maxShoppers ?? 50),
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const common = {
      startsAt: fromLocalInput(form.startsAt),
      maxPerCustomer: Number(form.max),
      admitPerSecond: Number(form.rate),
      ...(form.name ? { name: form.name } : {}),
    };
    try {
      const saved = drop
        ? await api<Drop>(`/drops/${drop.id}`, { method: 'PATCH', body: { ...common, maxShoppers: form.mode === 'window' ? Number(form.shoppers) : null } })
        : await api<Drop>('/drops', { method: 'POST', body: { ...common, productId: Number(form.productId), ...(form.mode === 'window' ? { maxShoppers: Number(form.shoppers) } : {}) } });
      toast(drop ? 'Drop updated' : `Drop #${saved.id} created`, 'success');
      queryClient.invalidateQueries({ queryKey: ['drops'] });
      onDone(drop ? undefined : saved.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <form className={drop ? 'space-y-3' : 'card space-y-3 p-5 animate-fade-up'} onSubmit={submit}>
      <h3 className="font-bold">{drop ? `Edit drop #${drop.id}` : 'New drop'}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {!drop && (
          <Field label="Product ID" hint="Find it in the Products tab (#id)">
            <input className="input" type="number" min={1} required value={form.productId} onChange={set('productId')} />
          </Field>
        )}
        <Field label="Name" hint={drop ? undefined : 'Empty = the product name'}>
          <input className="input" maxLength={200} value={form.name} onChange={set('name')} required={Boolean(drop)} />
        </Field>
        <Field label="Starts at" hint="Your local time. The line opens 10 min before.">
          <input className="input" type="datetime-local" required value={form.startsAt} onChange={set('startsAt')} />
        </Field>
        <Field label="Max per customer"><input className="input" type="number" min={1} max={10} required value={form.max} onChange={set('max')} /></Field>
        <Field label="Waiting room">
          <select className="input" value={form.mode} onChange={set('mode')}>
            <option value="rate">Let in N buyers per second</option>
            <option value="window">"One out, one in": at most N shopping at once</option>
          </select>
        </Field>
        {form.mode === 'rate' ? (
          <Field label="Buyers per second"><input className="input" type="number" min={1} max={10000} required value={form.rate} onChange={set('rate')} /></Field>
        ) : (
          <Field label="Max shoppers at once"><input className="input" type="number" min={1} max={10000} required value={form.shoppers} onChange={set('shoppers')} /></Field>
        )}
      </div>
      {drop && <p className="text-xs text-slate-500">Changing the start of a live drop moves its line: in the timed mode, called numbers are computed from the start time.</p>}
      {error && <ErrorBox message={error} />}
      <div className="flex gap-2">
        <button className="btn-primary">{drop ? 'Save' : 'Create drop'}</button>
        <button type="button" className="btn-ghost" onClick={() => onDone()}>Cancel</button>
      </div>
    </form>
  );
}
