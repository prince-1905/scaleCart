import { Logger } from '@nestjs/common';
import { LlmError, type LlmClient, type LlmReply, type LlmRequest, type ToolCall } from './llm-client.js';
import type { ShopTools, ToolOutcome } from './shop-tools.js';
import { MAX_ROUNDS, ShoppingAssistant } from './shopping-assistant.js';

const usage = { inputTokens: 100, outputTokens: 10, thinkingTokens: 0 };
const answer = (text: string): LlmReply => ({
  turn: { role: 'model', text, toolCalls: [] },
  finishReason: 'STOP',
  usage,
});
const askTool = (...toolCalls: ToolCall[]): LlmReply => ({
  turn: { role: 'model', text: '', toolCalls },
  finishReason: 'STOP',
  usage,
});
const search: ToolCall = { id: 'c1', name: 'search_products', args: { query: 'shoes' } };
const SHOES = { id: 7, name: 'Stride Lite Running Shoes', category: 'footwear', priceInr: 2499 };

/** A model that replays scripted replies and records what it was sent. */
function fakeLlm(...replies: LlmReply[]) {
  const requests: LlmRequest[] = [];
  const generate = vi.fn(async (req: LlmRequest) => {
    requests.push({ ...req, turns: [...req.turns] }); // copy: the loop keeps appending to turns
    const next = replies.shift();
    if (!next) throw new Error('fake model ran out of replies');
    return next;
  });
  const llm: LlmClient = { model: 'fake-model', generate };
  return { llm, requests, generate };
}

function setup(llm: LlmClient, outcome: ToolOutcome = { ok: true, content: { count: 1 }, cards: [SHOES] }) {
  const tools = { specs: [], run: vi.fn(async () => outcome) };
  const assistant = new ShoppingAssistant(llm, tools as unknown as ShopTools);
  return { assistant, tools };
}

const ctx = { userId: 'user-a' };
const ask = (text: string) => [{ role: 'user' as const, text }];

describe('ShoppingAssistant (agent loop)', () => {
  beforeEach(() => {
    // The loop logs every round; keep test output readable.
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('runs the tool the model asks for, sends the result back, and returns the answer', async () => {
    const { llm, requests } = fakeLlm(askTool(search), answer('Stride Lite Running Shoes, ₹2,499.'));
    const { assistant, tools } = setup(llm);
    const events: string[] = [];

    const out = await assistant.chat(ask('running shoes under 3000'), ctx, (e) => events.push(e.type));

    expect(tools.run).toHaveBeenCalledWith(search, ctx);
    // Round 2 saw: the question, the model's tool call, and our tool result.
    expect(requests[1].turns.map((t) => t.role)).toEqual(['user', 'model', 'tool']);
    expect(requests[1].turns[2]).toEqual({
      role: 'tool',
      results: [{ callId: 'c1', name: 'search_products', ok: true, content: { count: 1 } }],
    });
    expect(out).toMatchObject({
      reply: 'Stride Lite Running Shoes, ₹2,499.',
      products: [SHOES],
      toolCalls: [{ name: 'search_products', args: { query: 'shoes' }, ok: true }],
      stats: { model: 'fake-model', rounds: 2, stoppedBy: 'answer', inputTokens: 200, outputTokens: 20 },
    });
    expect(events).toEqual(['tool_start', 'tool_end']);
  });

  it('answers directly when no tool is needed', async () => {
    const { llm } = fakeLlm(answer('Hi! What are you shopping for?'));
    const { assistant, tools } = setup(llm);
    const out = await assistant.chat(ask('hello'), ctx);
    expect(out.stats.rounds).toBe(1);
    expect(tools.run).not.toHaveBeenCalled();
  });

  it('passes a tool error back to the model so it can recover', async () => {
    const { llm, requests } = fakeLlm(askTool(search), answer('Sorry, our store is having trouble.'));
    const { assistant } = setup(llm, { ok: false, content: { error: 'temporary problem' }, cards: [] });

    const out = await assistant.chat(ask('shoes'), ctx);

    expect(requests[1].turns[2]).toMatchObject({ role: 'tool', results: [{ ok: false }] });
    expect(out).toMatchObject({ reply: 'Sorry, our store is having trouble.', toolCalls: [{ ok: false }] });
  });

  it(`stops after ${MAX_ROUNDS} rounds if the model never stops calling tools`, async () => {
    const { llm, generate } = fakeLlm(...Array.from({ length: 10 }, () => askTool(search)));
    const { assistant, tools } = setup(llm);

    const out = await assistant.chat(ask('shoes'), ctx);

    expect(generate).toHaveBeenCalledTimes(MAX_ROUNDS);
    expect(tools.run).toHaveBeenCalledTimes(MAX_ROUNDS);
    expect(out.stats).toMatchObject({ rounds: MAX_ROUNDS, stoppedBy: 'max_rounds' });
    expect(out.reply).toMatch(/couldn't finish/);
  });

  it('stops before the next round once the client has gone away', async () => {
    const { llm, generate } = fakeLlm(askTool(search), answer('never sent'));
    const { assistant } = setup(llm);
    const cancel = new AbortController();

    // The browser disconnects while the first tool runs.
    const out = await assistant.chat(ask('shoes'), ctx, (e) => e.type === 'tool_end' && cancel.abort(), cancel.signal);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(out.stats).toMatchObject({ rounds: 1, stoppedBy: 'cancelled' });
  });

  it('runs no tools if the client left while the model was thinking', async () => {
    const cancel = new AbortController();
    const { llm } = fakeLlm(askTool({ id: 'c1', name: 'add_to_cart', args: { product_id: 7, quantity: 1 } }));
    const generate = llm.generate.bind(llm);
    llm.generate = async (req) => {
      const reply = await generate(req);
      cancel.abort(); // the browser closes while the model call is in flight
      return reply;
    };
    const { assistant, tools } = setup(llm);

    const out = await assistant.chat(ask('add the shoes'), ctx, undefined, cancel.signal);

    expect(tools.run).not.toHaveBeenCalled();
    expect(out.stats.stoppedBy).toBe('cancelled');
  });

  it('sends only the latest 20 messages, as user/model turns', async () => {
    const { llm, requests } = fakeLlm(answer('ok'));
    const { assistant } = setup(llm);
    const history = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `message ${i}`,
    }));

    await assistant.chat(history, ctx);

    const turns = requests[0].turns;
    expect(turns).toHaveLength(20);
    expect(turns[0]).toEqual({ role: 'model', text: 'message 5', toolCalls: [] });
    expect(turns.at(-1)).toEqual({ role: 'user', text: 'message 24' });
  });

  it('lets provider errors through for the controller to turn into HTTP errors', async () => {
    const llm: LlmClient = {
      model: 'fake-model',
      generate: async () => {
        throw new LlmError('rate_limited', 'quota');
      },
    };
    const { assistant } = setup(llm);
    await expect(assistant.chat(ask('shoes'), ctx)).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});
