import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LlmClient, LlmUsage, ToolResult, Turn } from './llm-client.js';
import { ShopTools, type ProductCard, type ToolContext } from './shop-tools.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

/** The model client. Null when GEMINI_API_KEY is not set (the assistant is switched off). */
export const LLM_CLIENT = Symbol('LLM_CLIENT');

/** Loop guard. A normal question needs 1-3 rounds; 5 means the model is going in circles. */
export const MAX_ROUNDS = 5;
/** No new round after this: NGINX allows /ai/ 90 s, and one model call may take up to 30 s. */
const TIME_BUDGET_MS = 45_000;
/** Older messages are dropped: every call resends the whole history, so it costs tokens each time. */
export const MAX_HISTORY = 20;
const MAX_CARDS = 6;

/** A message as the browser sends it: plain text only, no tool calls. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface ToolTrace {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
}

/** answer = the model replied in words; cancelled = the client went away; the others = a guard stopped the loop. */
export type StopReason = 'answer' | 'max_rounds' | 'time_budget' | 'cancelled';

export interface ChatResult {
  reply: string;
  /** Products the tools returned, for the widget's cards. */
  products: ProductCard[];
  toolCalls: ToolTrace[];
  stats: LlmUsage & { model: string; rounds: number; stoppedBy: StopReason; durationMs: number };
}

/** Progress while the loop runs, so the widget can show "🔧 searching products…". */
export type ChatEvent =
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string; ok: boolean; durationMs: number };

/**
 * The agent loop, written out by hand:
 *
 *   ask the model → it wants tools? → run them, append the results, ask again
 *                 → it answered in words? → done
 *
 * The model only ever *asks* for a tool; ShopTools validates and runs it for the
 * signed-in user. Provider errors (LlmError) are left to the caller.
 */
@Injectable()
export class ShoppingAssistant {
  private readonly logger = new Logger(ShoppingAssistant.name);

  constructor(
    @Inject(LLM_CLIENT) private readonly llm: LlmClient | null,
    private readonly tools: ShopTools,
  ) {}

  get enabled(): boolean {
    return this.llm !== null;
  }

  async chat(
    history: ChatMessage[],
    ctx: ToolContext,
    onEvent: (event: ChatEvent) => void = () => {},
    /** Aborted when the browser disconnects: no point paying for rounds nobody will read. */
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    if (!this.llm) throw new Error('AI assistant is not configured (GEMINI_API_KEY)');
    const started = Date.now();
    const turns: Turn[] = history
      .slice(-MAX_HISTORY)
      .map((m) =>
        m.role === 'user'
          ? { role: 'user', text: m.text }
          : { role: 'model', text: m.text, toolCalls: [] },
      );
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
    const toolCalls: ToolTrace[] = [];
    const cards = new Map<number, ProductCard>();

    const finish = (reply: string, rounds: number, stoppedBy: StopReason): ChatResult => {
      const stats = { model: this.llm!.model, rounds, stoppedBy, durationMs: Date.now() - started, ...usage };
      this.logger.log(
        `chat done: ${stoppedBy}, ${rounds} round(s), ${toolCalls.length} tool call(s), ` +
          `${usage.inputTokens} in / ${usage.outputTokens} out / ${usage.thinkingTokens} thinking tokens, ` +
          `${stats.durationMs} ms`,
      );
      return { reply, products: [...cards.values()].slice(0, MAX_CARDS), toolCalls, stats };
    };

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (signal?.aborted) {
        this.logger.warn(`chat cancelled: client went away after ${round - 1} round(s)`);
        return finish('', round - 1, 'cancelled');
      }
      if (Date.now() - started > TIME_BUDGET_MS) {
        this.logger.warn(`chat stopped: time budget used up after ${round - 1} round(s)`);
        return finish('Sorry, that took too long. Please try again.', round - 1, 'time_budget');
      }

      const roundStarted = Date.now();
      const reply = await this.llm.generate({ system: SYSTEM_PROMPT, turns, tools: this.tools.specs });
      usage.inputTokens += reply.usage.inputTokens;
      usage.outputTokens += reply.usage.outputTokens;
      usage.thinkingTokens += reply.usage.thinkingTokens;
      turns.push(reply.turn);
      const calls = reply.turn.toolCalls;
      this.logger.log(
        `round ${round}: ${calls.length ? `${calls.length} tool call(s)` : 'answer'}, ` +
          `${reply.usage.inputTokens} in / ${reply.usage.outputTokens} out tokens, ${Date.now() - roundStarted} ms`,
      );

      // Checked again here: no tools (and no cart changes) for someone who has already left.
      // (Aborting the model call itself wouldn't help: Gemini finishes and bills it anyway.)
      if (signal?.aborted) {
        this.logger.warn(`chat cancelled: client went away during round ${round}`);
        return finish('', round, 'cancelled');
      }
      if (calls.length === 0) {
        const text = reply.turn.text.trim();
        if (!text) this.logger.warn(`empty answer (finish reason ${reply.finishReason})`);
        return finish(text || "Sorry, I couldn't answer that. Could you say it another way?", round, 'answer');
      }

      // One at a time, in the model's order: two add_to_cart calls for the same product must not race.
      const results: ToolResult[] = [];
      for (const call of calls) {
        onEvent({ type: 'tool_start', name: call.name });
        const toolStarted = performance.now();
        const outcome = await this.tools.run(call, ctx);
        const durationMs = Math.round(performance.now() - toolStarted);
        this.logger.log(
          `tool ${call.name} ${JSON.stringify(call.args)} → ${outcome.ok ? 'ok' : 'error'} ` +
            `${preview(outcome.content)} (${durationMs} ms)`,
        );
        onEvent({ type: 'tool_end', name: call.name, ok: outcome.ok, durationMs });
        toolCalls.push({ name: call.name, args: call.args, ok: outcome.ok, durationMs });
        for (const c of outcome.cards) cards.set(c.id, c);
        results.push({ callId: call.id, name: call.name, ok: outcome.ok, content: outcome.content });
      }
      turns.push({ role: 'tool', results });
    }

    this.logger.warn(`chat stopped: still calling tools after ${MAX_ROUNDS} rounds`);
    return finish(
      "Sorry, I couldn't finish that. Could you ask in a simpler way?",
      MAX_ROUNDS,
      'max_rounds',
    );
  }
}

/** Keeps log lines readable: the first 300 characters of a tool result. */
function preview(content: unknown): string {
  const json = JSON.stringify(content);
  return json.length > 300 ? `${json.slice(0, 300)}…` : json;
}
