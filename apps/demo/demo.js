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
  $('orders').hidden = true;
  setPayStatus(null);
  $('admin').hidden = true;
  $('copy-form').hidden = true;
  setCopyStatus(null);
  $('who').hidden = true;
  $('logout').hidden = true;
  setChatEnabled(false);
  for (const state of lines.values()) clearTimeout(state.timer);
  lines.clear();
  renderDrops();
  if (message) {
    $('login-error').textContent = message;
    $('login-error').hidden = false;
  }
}

function showLoggedIn() {
  $('login').hidden = true;
  $('cart').hidden = false;
  $('orders').hidden = false;
  refreshOrders();
  $('admin').hidden = !isAdmin();
  $('who').textContent = sessionStorage.getItem('email') ?? '';
  $('who').hidden = false;
  $('logout').hidden = false;
  setChatEnabled(true);
  refreshCart();
  renderDrops(); // the Join buttons need a login
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
  $('checkout').disabled = cart.items.length === 0;
}

// ---------- drops and the waiting room ----------

let drops = [];
let clockOffsetMs = 0; // server clock minus this browser's clock
const lines = new Map(); // dropId → { status, timer } for drops this visitor has joined

const serverNow = () => Date.now() + clockOffsetMs;

function formatCountdown(ms) {
  if (ms <= 0) return 'live now';
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return `starts in ${h ? `${h}:` : ''}${pad(m)}:${pad(s % 60)}`;
}

async function refreshDrops() {
  const res = await fetch('/drops');
  if (!res.ok) return;
  drops = await res.json();
  if (drops.length) clockOffsetMs = Date.parse(drops[0].serverTime) - Date.now();
  renderDrops();
}

function renderDrops() {
  const list = $('drop-list');
  list.replaceChildren();
  if (drops.length === 0) list.append(el('li', 'empty', 'No drops right now.'));
  for (const drop of drops) {
    const li = el('li', 'drop');
    li.dataset.dropId = drop.id;
    const head = el('div', 'drop-head');
    head.append(
      el('strong', '', drop.name),
      el('span', '', `${inr(drop.product.priceCents / 100)} · ${drop.available ?? '?'} left · max ${drop.maxPerCustomer} each`),
    );
    const countdown = el('span', 'countdown');
    countdown.dataset.startsAt = drop.startsAt;
    const line = el('div', 'line');
    li.append(head, countdown, line);
    list.append(li);
    renderLine(drop);
  }
  tickCountdowns();
}

function tickCountdowns() {
  for (const span of document.querySelectorAll('.countdown')) {
    span.textContent = formatCountdown(Date.parse(span.dataset.startsAt) - serverNow());
  }
}
setInterval(tickCountdowns, 1000);

/** The line part of one drop: a Join button, your ticket and place, or Buy now. */
function renderLine(drop) {
  const box = document.querySelector(`li[data-drop-id="${drop.id}"] .line`);
  if (!box) return;
  box.replaceChildren();
  const state = lines.get(drop.id);
  if (!token) {
    box.append(el('span', 'hint', 'Log in to join the line.'));
  } else if (!state) {
    const join = el('button', 'join', 'Join the line');
    join.addEventListener('click', () => joinLine(drop));
    box.append(join);
  } else if (state.error) {
    box.append(el('span', 'error', state.error));
  } else if (!state.status.admitted) {
    const s = state.status;
    box.append(el('span', '', `🎟 Ticket #${s.ticket} · ${s.position} ahead of you · about ${s.etaSeconds} s`));
  } else {
    const until = new Date(state.status.passExpiresAt).toLocaleTimeString();
    const buy = el('button', 'join', 'Buy now');
    buy.addEventListener('click', () => buyDrop(drop, state.status.pass));
    box.append(el('span', '', `✅ Your turn! Buy before ${until}. `), buy);
  }
}

/** Joins the line (or asks where we are), then asks again when the estimate says our turn is near. */
async function joinLine(drop) {
  const state = lines.get(drop.id) ?? {};
  clearTimeout(state.timer);
  const res = await api(`/drops/${drop.id}/queue`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const retry = res.status === 503; // waiting room briefly unavailable: try again
    lines.set(drop.id, { error: errorMessage(body, res.status), timer: retry ? setTimeout(() => joinLine(drop), 3000) : undefined });
  } else {
    const next = body.admitted ? undefined : setTimeout(() => joinLine(drop), Math.min(5, Math.max(1, body.etaSeconds)) * 1000);
    lines.set(drop.id, { status: body, timer: next });
  }
  renderLine(drop);
}

async function buyDrop(drop, pass) {
  setPayStatus(`Buying ${drop.name}…`);
  // The drop product only; whatever else is in the cart stays for a normal checkout.
  const cart = await api(`/cart/items/${drop.product.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quantity: 1 }),
  });
  if (!cart.ok) {
    setPayStatus(errorMessage(await cart.json().catch(() => ({})), cart.status), true);
    return;
  }
  checkoutKey ??= crypto.randomUUID();
  const res = await api('/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': checkoutKey },
    body: JSON.stringify({ dropPass: pass }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    setPayStatus(errorMessage(body, res.status), true);
    if (res.status !== 409) return;
    checkoutKey = null; // a definite "no" (sold out, already bought): the next try is a new attempt
    refreshDrops();
    return;
  }
  checkoutKey = null;
  lines.delete(drop.id);
  await Promise.all([refreshCart(), refreshOrders(), refreshDrops()]);
  await pay(body.id);
}

$('refresh-drops').addEventListener('click', () => refreshDrops());

$('drop-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const startsAt = new Date(serverNow() + Number($('drop-minutes').value) * 60_000).toISOString();
  const res = await api('/drops', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      productId: Number($('drop-product').value),
      startsAt,
      admitPerSecond: Number($('drop-rate').value),
      maxPerCustomer: Number($('drop-max').value),
      ...($('drop-shoppers').value ? { maxShoppers: Number($('drop-shoppers').value) } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  $('drop-form-status').hidden = false;
  $('drop-form-status').textContent = res.ok ? `Drop #${body.id} created: ${body.name}` : errorMessage(body, res.status);
  if (res.ok) refreshDrops();
});

// ---------- checkout and payment (Razorpay test mode) ----------

const STATUS_LABEL = { pending_payment: 'waiting for payment', paid: 'paid ✅', cancelled: 'cancelled' };
// One key per checkout attempt, reused if the same attempt is retried (e.g. after a network error).
let checkoutKey = null;

function setPayStatus(text, isError = false) {
  $('pay-status').hidden = !text;
  $('pay-status').textContent = text ?? '';
  $('pay-status').classList.toggle('error', isError);
}

$('checkout').addEventListener('click', async () => {
  $('checkout').disabled = true;
  checkoutKey ??= crypto.randomUUID();
  const res = await api('/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': checkoutKey },
    body: '{}',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    setPayStatus(errorMessage(body, res.status), true);
    $('checkout').disabled = false;
    return;
  }
  checkoutKey = null;
  await refreshCart();
  await refreshOrders();
  await pay(body.id);
});

$('refresh-orders').addEventListener('click', () => refreshOrders());

async function refreshOrders() {
  const res = await api('/orders?limit=5');
  if (!res.ok) return;
  const { items } = await res.json();
  const list = $('order-items');
  list.replaceChildren();
  if (items.length === 0) list.append(el('li', 'empty', 'No orders yet.'));
  for (const order of items) {
    const li = el('li');
    li.append(el('span', '', `#${order.id.slice(-6)} · ${inr(order.totalCents / 100)} · ${STATUS_LABEL[order.status] ?? order.status}`));
    if (order.status === 'pending_payment') {
      const button = el('button', 'link', 'Pay');
      button.addEventListener('click', () => pay(order.id));
      li.append(button);
    }
    list.append(li);
  }
}

let checkoutScript = null;
/** Razorpay's checkout script, loaded only when someone pays. */
function loadRazorpay() {
  checkoutScript ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = resolve;
    s.onerror = () => {
      checkoutScript = null;
      reject(new Error('could not load Razorpay Checkout'));
    };
    document.head.append(s);
  });
  return checkoutScript;
}

async function pay(orderId) {
  setPayStatus('Opening Razorpay…');
  const res = await api(`/orders/${orderId}/payment`, { method: 'POST' });
  const session = await res.json().catch(() => ({}));
  if (!res.ok) {
    setPayStatus(errorMessage(session, res.status), true);
    return;
  }
  try {
    await loadRazorpay();
  } catch (err) {
    setPayStatus(err.message, true);
    return;
  }
  const secondsLeft = Math.floor((new Date(session.expiresAt) - Date.now()) / 1000);
  const checkout = new window.Razorpay({
    key: session.keyId,
    order_id: session.providerOrderId,
    amount: session.amountPaise,
    currency: session.currency,
    name: 'ScaleCart (test mode)',
    description: `Order #${orderId.slice(-6)}`,
    prefill: { email: sessionStorage.getItem('email') ?? '' },
    // Close the payment page before our order expires, so nobody pays for a cancelled order.
    timeout: Math.max(secondsLeft - 30, 30),
    theme: { color: '#2563eb' },
    // Redirect mode: the bank page replaces this page instead of opening a pop-up window
    // (pop-ups got blocked in testing). Razorpay then POSTs the result to our callback,
    // which sends the browser back here with ?order=…&payment=….
    redirect: true,
    callback_url: `${location.origin}/payments/razorpay/callback?order=${orderId}`,
    handler: (response) => confirmPayment(orderId, response),
    modal: {
      ondismiss: () => setPayStatus(`Payment not finished. The order is held until ${new Date(session.expiresAt).toLocaleTimeString()}.`),
    },
  });
  checkout.on('payment.failed', (response) => {
    setPayStatus(`Payment failed: ${response.error?.description ?? 'unknown error'}. You can try again.`, true);
  });
  checkout.open();
}

/** Back from Razorpay's redirect: our callback put the result in the address. */
async function showRedirectResult() {
  const params = new URLSearchParams(location.search);
  const orderId = params.get('order');
  const result = params.get('payment');
  if (!result) return;
  history.replaceState(null, '', location.pathname); // a reload shouldn't show it again
  if (result === 'failed' || result === 'error') {
    const why = result === 'failed' ? params.get('reason') ?? 'payment failed' : 'the payment could not be verified';
    setPayStatus(`Payment not completed: ${why}. You can try again.`, true);
    return;
  }
  if (orderId) await waitForPaid(orderId, result === 'paid' ? 'paid' : 'pending_payment');
}

/**
 * Razorpay says "paid" in the browser. Our API checks the signature and asks Razorpay
 * itself; the webhook settles the order either way, so we then just wait for "paid".
 */
async function confirmPayment(orderId, response) {
  setPayStatus('Payment received by Razorpay, confirming…');
  const res = await api('/payments/razorpay/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerOrderId: response.razorpay_order_id,
      paymentId: response.razorpay_payment_id,
      signature: response.razorpay_signature,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    setPayStatus(errorMessage(body, res.status), true);
    return;
  }
  await waitForPaid(orderId, body.orderStatus);
}

/** Polls the order for up to 20 s: the webhook may land a moment after the browser. */
async function waitForPaid(orderId, status) {
  setPayStatus('Payment received by Razorpay, confirming…');
  for (let i = 0; i < 20 && status === 'pending_payment'; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    status = (await (await api(`/orders/${orderId}`)).json()).status;
  }
  setPayStatus(
    status === 'paid'
      ? `Paid ✅ Order #${orderId.slice(-6)} is confirmed.`
      : status === 'cancelled'
        ? 'The order had expired: your money will be refunded automatically.'
        : 'Still waiting for Razorpay to confirm. Refresh in a moment.',
    status === 'cancelled',
  );
  refreshOrders();
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
if (token) {
  showLoggedIn();
  showRedirectResult();
}
else logout();
refreshDrops();
