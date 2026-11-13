import { useState, type FormEvent } from 'react';
import { ErrorBox, useToast } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { CATEGORY_STYLE } from '../../lib/format';
import { CATEGORIES, type Category } from '../../lib/types';
import { Field } from './shared';

interface Copy {
  title: string;
  short_description: string;
  long_description: string;
  bullet_features: string[];
  seo_title: string;
  seo_description: string;
  tags: string[];
}

/** AI product copy: the model drafts, a human reviews and edits, and only then is anything saved (E3.5g). */
export function ProductCopy() {
  const toast = useToast();
  const [req, setReq] = useState({ name: '', category: 'footwear' as Category, notes: '' });
  const [copy, setCopy] = useState<Copy | null>(null);
  const [productId, setProductId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ copy: Copy }>('/ai/product-copy', { method: 'POST', body: { name: req.name, category: req.category, notes: req.notes || undefined } });
      setCopy(res.copy);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!copy) return;
    try {
      // The products table has name/description/category only: the bullets join the description.
      const description = `${copy.long_description}\n\n${copy.bullet_features.map((b) => `- ${b}`).join('\n')}`;
      await api(`/products/${Number(productId)}`, { method: 'PATCH', body: { name: copy.title, description, category: req.category } });
      toast(`Saved to product #${productId}`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  const edit = (k: keyof Copy) => (e: { target: { value: string } }) =>
    setCopy((c) => (c ? { ...c, [k]: k === 'bullet_features' ? e.target.value.split('\n') : k === 'tags' ? e.target.value.split(',').map((t) => t.trim()) : e.target.value } : c));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form className="card space-y-4 p-6" onSubmit={generate}>
        <h2 className="text-lg font-bold">Product copy with AI ✨</h2>
        <Field label="Product name"><input className="input" required minLength={2} maxLength={200} value={req.name} onChange={(e) => setReq({ ...req, name: e.target.value })} /></Field>
        <Field label="Category">
          <select className="input" value={req.category} onChange={(e) => setReq({ ...req, category: e.target.value as Category })}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_STYLE[c].label}</option>)}
          </select>
        </Field>
        <Field label="Facts (the AI may only use these)">
          <textarea className="input" rows={3} maxLength={2000} placeholder="breathable mesh, 280 g, sizes 6–11" value={req.notes} onChange={(e) => setReq({ ...req, notes: e.target.value })} />
        </Field>
        {error && <ErrorBox message={error} />}
        <button className="btn-primary w-full" disabled={busy}>{busy ? 'Writing…' : 'Generate'}</button>
      </form>

      {copy ? (
        <div className="card space-y-3 p-6 animate-fade-up">
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
            Read it before saving: in testing, every draft passed validation and still invented claims ("durable", "for Men").
          </p>
          <Field label="Title"><input className="input" value={copy.title} onChange={edit('title')} /></Field>
          <Field label="Description"><textarea className="input" rows={5} value={copy.long_description} onChange={edit('long_description')} /></Field>
          <Field label="Features (one per line)"><textarea className="input" rows={4} value={copy.bullet_features.join('\n')} onChange={edit('bullet_features')} /></Field>
          <Field label="Tags (review only)"><input className="input" value={copy.tags.join(', ')} onChange={edit('tags')} /></Field>
          <div className="flex gap-3">
            <input className="input" type="number" min={1} placeholder="Product ID" value={productId} onChange={(e) => setProductId(e.target.value)} aria-label="Save to product ID" />
            <button className="btn-primary shrink-0" onClick={save} disabled={!productId}>Save to product</button>
          </div>
        </div>
      ) : (
        <div className="card grid place-items-center p-6 text-center text-sm text-slate-500">
          The draft appears here. Nothing is saved until you review it and pick a product.
        </div>
      )}
    </div>
  );
}
