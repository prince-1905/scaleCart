// ScaleCart demo page: login, cart panel and the AI chat widget. Plain JS, no build step.
// Served by NGINX from the same address as the API, so calls are same-origin (no CORS).
// The Gemini key never reaches this page: the browser only talks to our API.

const CATEGORY_EMOJI = {
  electronics: '🎧', fashion: '👕', footwear: '👟', home: '🛋️',
  kitchen: '🍳', beauty: '💄', sports: '🏏', books: '📚',
};
const TOOL_LABELS = {
  search_products: 'searching products',
  get_product_details: 'reading product details',
  check_stock: 'checking stock',
  add_to_cart: 'adding to your cart',
  get_order_status: 'looking up your orders',
};
const SUGGESTIONS = [
  'Running shoes under ₹3,000',
  'A gift for my dad under ₹2,000',
  'Are the QuietMax headphones in stock?',
  'Where is my last order?',
];
const MAX_HISTORY = 20; // the API accepts at most 20 messages

const $ = (id) => document.getElementById(id);
const inr = (rupees) => `₹${rupees.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// Demo shortcut: the access token lives in sessionStorage. A real shop would keep the refresh
// token in an httpOnly cookie, out of reach of page scripts.
let token = sessionStorage.getItem('token');
let history = []; // [{ role: 'user' | 'assistant', text }]
let busy = false;

// ---------- login and cart ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 401 && token) {
    logout('Your session expired. Please log in again.');
  }
  return res;
}

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').hidden = true;
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: $('email').value, password: $('password').value }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('login-error').textContent = body.message ?? 'Login failed';
    $('login-error').hidden = false;
    return;
  }
  token = body.accessToken;
  sessionStorage.setItem('token', token);
  sessionStorage.setItem('email', $('email').value);
  $('password').value = '';
  showLoggedIn();
});

$('logout').addEventListener('click', () => logout());

function logout(message) {
  token = null;
  sessionStorage.clear();
  $('login').hidden = false;
  $('cart').hidden = true;
  $('admin').hidden = true;
  $('copy-form').hidden = true;
  setCopyStatus(null);
  $('who').hidden = true;
  $('logout').hidden = true;
  setChatEnabled(false);
  if (message) {
    $('login-error').textContent = message;
    $('login-error').hidden = false;
  }
}

function showLoggedIn() {
  $('login').hidden = true;
  $('cart').hidden = false;
  $('admin').hidden = !isAdmin();
  $('who').textContent = sessionStorage.getItem('email') ?? '';
  $('who').hidden = false;
  $('logout').hidden = false;
  setChatEnabled(true);
  refreshCart();
}

async function refreshCart() {
  const res = await api('/cart');
  if (!res.ok) return;
  const cart = await res.json();
  const list = $('cart-items');
  list.replaceChildren();
  if (cart.items.length === 0) {
    list.append(el('li', 'empty', 'Your cart is empty.'));
  }
  for (const item of cart.items) {
    const li = el('li');
    li.append(el('span', '', `${item.name} × ${item.quantity}`), el('span', '', inr(item.lineTotalCents / 100)));
    list.append(li);
  }
  $('cart-total').textContent = inr(cart.totalCents / 100);
}

// No Content-Type on a bodyless DELETE: Fastify rejects an empty JSON body.
$('clear-cart').addEventListener('click', async () => {
  await api('/cart', { method: 'DELETE' });
  refreshCart();
});

// ---------- admin: AI product copy ----------

/** Only decides what to show. The role is read from the token here, but the API checks it on every call. */
function isAdmin() {
  try {
    const payload = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
    return JSON.parse(atob(payload)).role === 'admin';
  } catch {
    return false;
  }
}

function setCopyStatus(text, isError = false) {
  $('copy-status').hidden = !text;
  $('copy-status').textContent = text ?? '';
  $('copy-status').className = isError ? 'error' : 'hint';
}

/** Validation errors arrive as a list of messages, everything else as one. */
const errorMessage = (body, status) => [body.message ?? `Request failed (${status})`].flat().join(', ');

for (const category of Object.keys(CATEGORY_EMOJI)) {
  const option = el('option', '', category);
  option.value = category;
  $('copy-category').append(option);
}

$('copy-request').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('copy-generate').disabled = true;
  $('copy-form').hidden = true;
  setCopyStatus('Writing… this can take a few seconds.');
  try {
    const res = await api('/ai/product-copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: $('copy-name').value,
        category: $('copy-category').value,
        notes: $('copy-notes').value,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setCopyStatus(errorMessage(body, res.status), true);
    fillCopyForm(body.copy);
    const { stats, attempts } = body;
    setCopyStatus(
      `Valid on attempt ${attempts} · ${(stats.durationMs / 1000).toFixed(1)} s · ` +
        `${(stats.inputTokens + stats.outputTokens).toLocaleString('en-IN')} tokens`,
    );
  } catch {
    setCopyStatus('Connection problem. Please try again.', true);
  } finally {
    $('copy-generate').disabled = false;
  }
});

/** .value treats the model's text as plain text, so it can't inject HTML (same rule as the chat). */
function fillCopyForm(copy) {
  $('copy-title').value = copy.title;
  $('copy-short').value = copy.short_description;
  $('copy-long').value = copy.long_description;
  $('copy-bullets').value = copy.bullet_features.join('\n');
  $('copy-seo-title').value = copy.seo_meta_title;
  $('copy-seo-description').value = copy.seo_meta_description;
  $('copy-tags').value = copy.tags.join(', ');
  $('copy-form').hidden = false;
}

$('copy-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const bullets = $('copy-bullets').value.split('\n').map((line) => line.trim()).filter(Boolean);
  const id = $('copy-product-id').value;
  const res = await api(`/products/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: $('copy-title').value.trim(),
      description: [$('copy-long').value.trim(), bullets.map((b) => `- ${b}`).join('\n')].filter(Boolean).join('\n\n'),
      category: $('copy-category').value,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) setCopyStatus(`Saved to product ${body.id}: ${body.name}`);
  else setCopyStatus(errorMessage(body, res.status), true);
});

// ---------- chat widget ----------

$('chat-toggle').addEventListener('click', () => {
  $('chat').hidden = !$('chat').hidden;
  if (!$('chat').hidden) $('chat-input').focus();
});
$('chat-close').addEventListener('click', () => ($('chat').hidden = true));

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (text) send(text);
});

function setChatEnabled(enabled) {
  $('chat-input').disabled = !enabled || busy;
  $('chat-send').disabled = !enabled || busy;
  $('chat-input').placeholder = enabled ? 'Ask about products…' : 'Log in to chat';
}

function renderSuggestions() {
  const box = $('suggestions');
  box.replaceChildren();
  if (history.length > 0) return;
  for (const s of SUGGESTIONS) {
    const b = el('button', '', s);
    b.type = 'button';
    b.addEventListener('click', () => token && send(s));
    box.append(b);
  }
}

async function send(text) {
  if (busy || !token) return;
  busy = true;
  setChatEnabled(true);
  $('chat-input').value = '';
  history.push({ role: 'user', text });
  renderSuggestions();
  addMessage('user', text);
  setStatus('Thinking…');

  try {
    const res = await api('/ai/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history.slice(-MAX_HISTORY) }),
    });
    if (!res.ok) {
      // Checks that fail before streaming (login, limits, bad input) come back as normal HTTP errors.
      const body = await res.json().catch(() => ({}));
      return fail(body.message ?? `Request failed (${res.status})`);
    }
    for await (const event of readLines(res.body)) handleEvent(event);
  } catch {
    fail('Connection problem. Please try again.');
  } finally {
    busy = false;
    setStatus(null);
    setChatEnabled(Boolean(token));
    $('chat-input').focus();
  }
}

function handleEvent(event) {
  switch (event.type) {
    case 'tool_start':
      setStatus(`🔧 ${TOOL_LABELS[event.name] ?? event.name}…`);
      break;
    case 'tool_end':
      setStatus('Thinking…');
      break;
    case 'reply': {
      history.push({ role: 'assistant', text: event.reply });
      addMessage('assistant', event.reply, event);
      if (event.toolCalls.some((c) => c.name === 'add_to_cart' && c.ok)) refreshCart();
      break;
    }
    case 'error':
      fail(event.message);
      break;
  }
}

/** The failed question is dropped from the history, so the conversation sent next time stays clean. */
function fail(message) {
  if (history.at(-1)?.role === 'user') history.pop();
  addMessage('error', message);
}

/** NDJSON: the response arrives in chunks; each complete line is one JSON event. */
async function* readLines(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
}

function setStatus(text) {
  $('status').hidden = !text;
  $('status').textContent = text ?? '';
}

function addMessage(kind, text, reply) {
  const bubble = el('div', `msg ${kind}`);
  bubble.append(...formatText(text));

  if (reply?.products?.length) {
    const cards = el('div', 'cards');
    for (const p of reply.products) cards.append(productCard(p));
    bubble.append(cards);
  }
  if (reply?.stats) {
    const s = reply.stats;
    const tools = reply.toolCalls.length;
    bubble.append(
      el(
        'div',
        'stats',
        `${s.rounds} round${s.rounds === 1 ? '' : 's'} · ${tools} tool${tools === 1 ? '' : 's'} · ` +
          `${(s.durationMs / 1000).toFixed(1)} s · ${(s.inputTokens + s.outputTokens).toLocaleString('en-IN')} tokens`,
      ),
    );
  }
  $('messages').append(bubble);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function productCard(p) {
  const card = el('button', 'card');
  card.type = 'button';
  card.title = 'Ask about this product';
  const info = el('div');
  info.append(el('div', 'name', p.name), el('div', 'price', inr(p.priceInr)));
  card.append(el('div', 'tile', CATEGORY_EMOJI[p.category] ?? '🛍️'), info);
  card.addEventListener('click', () => send(`Tell me more about the ${p.name}`));
  return card;
}

/**
 * The model's text is untrusted (prompt injection could make it write HTML), so it is NEVER
 * inserted as HTML. Only "- " list lines and **bold** are turned into elements, via textContent.
 */
function formatText(text) {
  const nodes = [];
  let list = null;
  for (const line of text.split('\n')) {
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (item) {
      list ??= el('ul');
      list.append(withBold(el('li'), item[1]));
      continue;
    }
    if (list) nodes.push(list), (list = null);
    if (line.trim()) nodes.push(withBold(el('p'), line));
  }
  if (list) nodes.push(list);
  return nodes;
}

function withBold(parent, text) {
  text.split(/\*\*(.+?)\*\*/).forEach((part, i) => parent.append(i % 2 ? el('strong', '', part) : part));
  return parent;
}

function el(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------- start ----------

renderSuggestions();
if (token) showLoggedIn();
else logout();
