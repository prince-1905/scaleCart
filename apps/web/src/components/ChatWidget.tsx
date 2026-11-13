import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { errorMessage, send } from '../lib/api';
import { useAuth } from '../lib/auth';
import { categoryStyle, inr } from '../lib/format';
import type { Category } from '../lib/types';

interface Card {
  id: number;
  name: string;
  category: Category | null;
  priceInr: number;
}
interface Message {
  role: 'user' | 'assistant';
  text: string;
  cards?: Card[];
}
/** One line of the NDJSON stream from POST /ai/chat/stream. */
type StreamEvent =
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string }
  | { type: 'reply'; reply: string; cards: Card[]; toolCalls: { name: string; ok: boolean }[] }
  | { type: 'error'; message: string };

const TOOL_LABELS: Record<string, string> = {
  search_products: 'Searching products',
  get_product_details: 'Reading product details',
  check_stock: 'Checking stock',
  add_to_cart: 'Adding to your cart',
  get_order_status: 'Looking up your orders',
};
const SUGGESTIONS = ['Running shoes under ₹3,000', 'A gift for my dad under ₹2,000', 'Where is my last order?'];

/** Reads a streamed body line by line; each line is one JSON event. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }); // stream: a multi-byte character (₹) may span two chunks
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line) as StreamEvent;
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as StreamEvent;
}

export function ChatWidget() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), [messages, status]);

  async function ask(text: string) {
    if (busy || !text.trim()) return;
    const history: Message[] = [...messages, { role: 'user', text: text.trim() }];
    setMessages(history);
    setInput('');
    setBusy(true);
    setStatus('Thinking…');
    try {
      // The API only accepts plain text turns (it rebuilds tool calls itself), at most 20 messages.
      const res = await send('/ai/chat/stream', {
        method: 'POST',
        body: { messages: history.slice(-20).map(({ role, text: t }) => ({ role, text: t })) },
      });
      for await (const event of readLines(res.body!)) {
        if (event.type === 'tool_start') setStatus(`🔧 ${TOOL_LABELS[event.name] ?? event.name}…`);
        else if (event.type === 'tool_end') setStatus('Thinking…');
        else if (event.type === 'reply') {
          setMessages((m) => [...m, { role: 'assistant', text: event.reply, cards: event.cards }]);
          if (event.toolCalls.some((c) => c.name === 'add_to_cart' && c.ok)) queryClient.invalidateQueries({ queryKey: ['cart'] });
        } else if (event.type === 'error') throw new Error(event.message);
      }
    } catch (err) {
      // Drop the failed question, so the next request's history stays clean.
      // TypeError = the network itself failed; anything else carries a readable message (API or stream error).
      const text = err instanceof Error && !(err instanceof TypeError) ? err.message : errorMessage(err);
      setMessages(history.slice(0, -1).concat({ role: 'assistant', text: `⚠️ ${text}` }));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    ask(input);
  }

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-5 right-5 z-40 grid h-14 w-14 place-items-center rounded-full bg-linear-to-br from-brand-500 to-fuchsia-500 text-2xl text-white shadow-xl shadow-brand-600/30 transition hover:scale-105"
        aria-label={open ? 'Close the shopping assistant' : 'Open the shopping assistant'}
      >
        {open ? '✕' : '💬'}
      </button>
      {open && (
        <section className="card fixed bottom-24 right-5 z-40 flex h-[32rem] w-[min(24rem,calc(100vw-2.5rem))] flex-col overflow-hidden animate-fade-up" aria-label="Shopping assistant">
          <header className="bg-linear-to-r from-brand-600 to-fuchsia-600 px-4 py-3 text-white">
            <p className="font-semibold">Shopping assistant ✨</p>
            <p className="text-xs opacity-80">Finds products, checks stock, fills your cart. It can't pay for you.</p>
          </header>
          <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
            {!user && <p className="text-sm text-slate-500"><Link to="/login" className="font-semibold text-brand-600">Log in</Link> to chat: the assistant can fill your own cart.</p>}
            {user && messages.length === 0 && (
              <div className="space-y-2">
                <p className="text-sm text-slate-500">Try:</p>
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => ask(s)} className="block w-full rounded-xl border border-slate-200 px-3 py-2 text-left text-sm hover:border-brand-500 dark:border-slate-700">
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
                <div className={`max-w-[85%] whitespace-pre-line rounded-2xl px-3.5 py-2 text-sm ${m.role === 'user' ? 'bg-brand-600 text-white' : 'bg-slate-100 dark:bg-slate-800'}`}>
                  {m.text}
                </div>
                {m.cards && m.cards.length > 0 && (
                  <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                    {m.cards.map((c) => (
                      <Link key={c.id} to={`/products/${c.id}`} className="w-36 shrink-0 rounded-xl border border-slate-200 p-2 text-xs hover:border-brand-500 dark:border-slate-700">
                        <span className="text-2xl">{categoryStyle(c.category).emoji}</span>
                        <span className="mt-1 line-clamp-2 block font-medium">{c.name}</span>
                        <span className="font-bold">{inr(Math.round(c.priceInr * 100))}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {status && <p className="animate-pulse text-sm text-slate-500">{status}</p>}
            <div ref={bottom} />
          </div>
          <form onSubmit={submit} className="flex gap-2 border-t border-slate-200 p-3 dark:border-slate-800">
            <input className="input" placeholder="Ask about products…" maxLength={2000} value={input} onChange={(e) => setInput(e.target.value)} disabled={!user || busy} aria-label="Message" />
            <button className="btn-primary" disabled={!user || busy || !input.trim()}>Send</button>
          </form>
        </section>
      )}
    </>
  );
}
