/**
 * The only file that knows which AI provider we use.
 *
 * Everything else speaks the small, provider-neutral types below (turns, tool specs,
 * tool calls). Switching from Gemini to Claude or OpenAI means writing another class
 * that implements `LlmClient`, not touching the agent loop or the tools.
 *
 * No Nest decorators here on purpose: the "hello" script runs this file with plain node.
 */
import { ApiError, GoogleGenAI, ThinkingLevel, type Content, type Part } from '@google/genai';

/** A tool the model may ask us to run. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  /** false = tell the model the tool failed (bad input, not found…) so it can recover. */
  ok: boolean;
  content: unknown;
}

/**
 * One entry of the conversation.
 *   user   what the shopper typed
 *   model  the model's answer: text and/or tool calls
 *   tool   our results for the model's tool calls
 */
export type Turn =
  | { role: 'user'; text: string }
  | {
      role: 'model';
      text: string;
      toolCalls: ToolCall[];
      /** The provider's original message. Gemini needs it back unchanged (it carries "thought signatures"). */
      raw?: unknown;
    }
  | { role: 'tool'; results: ToolResult[] };

export interface LlmRequest {
  system: string;
  turns: Turn[];
  tools?: ToolSpec[];
  /** Ask for JSON matching this JSON Schema instead of free text (structured output). */
  jsonSchema?: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens the model spent thinking before answering. Billed like output on paid tiers. */
  thinkingTokens: number;
}

export interface LlmReply {
  /** Append this to `turns` before the next call. */
  turn: Extract<Turn, { role: 'model' }>;
  /** Why the model stopped, as the provider reports it (e.g. STOP, MAX_TOKENS, SAFETY). */
  finishReason: string;
  usage: LlmUsage;
}

export interface LlmClient {
  readonly model: string;
  generate(request: LlmRequest): Promise<LlmReply>;
}

/** invalid_output: the model answered, but not in the shape we asked for (structured output). */
export type LlmErrorKind = 'rate_limited' | 'timeout' | 'unavailable' | 'bad_request' | 'blocked' | 'invalid_output';

/** Provider errors, translated into a few kinds the rest of the app can act on. */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;

  constructor(kind: LlmErrorKind, message: string) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
  }
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
}

const THINKING_LEVELS = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export class GeminiClient implements LlmClient {
  readonly model: string;
  private readonly ai: GoogleGenAI;
  private readonly thinkingLevel: ThinkingLevel;

  constructor(options: GeminiOptions) {
    this.model = options.model;
    this.thinkingLevel = THINKING_LEVELS[options.thinkingLevel ?? 'minimal'];
    this.ai = new GoogleGenAI({
      apiKey: options.apiKey,
      // One retry for 429/5xx: more would hide free-tier limits behind long waits.
      httpOptions: { timeout: options.timeoutMs, retryOptions: { attempts: 2 } },
    });
  }

  async generate(request: LlmRequest): Promise<LlmReply> {
    let response;
    try {
      response = await this.ai.models.generateContent({
        model: this.model,
        contents: request.turns.map(toContent),
        config: {
          systemInstruction: request.system,
          // A shopping chat needs quick answers, not deep reasoning.
          thinkingConfig: { thinkingLevel: this.thinkingLevel },
          tools: request.tools?.length
            ? [
                {
                  functionDeclarations: request.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parametersJsonSchema: t.parameters,
                  })),
                },
              ]
            : undefined,
          responseMimeType: request.jsonSchema ? 'application/json' : undefined,
          responseJsonSchema: request.jsonSchema,
        },
      });
    } catch (err) {
      throw toLlmError(err);
    }

    const blocked = response.promptFeedback?.blockReason;
    if (blocked) throw new LlmError('blocked', `prompt blocked: ${blocked}`);

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const toolCalls = parts.flatMap((part, i) =>
      part.functionCall?.name
        ? [{ id: part.functionCall.id ?? `call_${i}`, name: part.functionCall.name, args: part.functionCall.args ?? {} }]
        : [],
    );
    const text = parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('');

    const usage = response.usageMetadata;
    return {
      turn: { role: 'model', text, toolCalls, raw: candidate?.content },
      finishReason: candidate?.finishReason ?? 'UNKNOWN',
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
        thinkingTokens: usage?.thoughtsTokenCount ?? 0,
      },
    };
  }
}

function toContent(turn: Turn): Content {
  switch (turn.role) {
    case 'user':
      return { role: 'user', parts: [{ text: turn.text }] };
    case 'model': {
      if (turn.raw) return turn.raw as Content;
      const parts: Part[] = [];
      if (turn.text) parts.push({ text: turn.text });
      for (const call of turn.toolCalls) parts.push({ functionCall: { name: call.name, args: call.args } });
      return { role: 'model', parts };
    }
    case 'tool':
      // Gemini sends tool results back as a "user" message made of functionResponse parts.
      return {
        role: 'user',
        parts: turn.results.map((r) => ({
          functionResponse: {
            id: r.callId.startsWith('call_') ? undefined : r.callId,
            name: r.name,
            response: r.ok ? { result: r.content } : { error: r.content },
          },
        })),
      };
  }
}

function toLlmError(err: unknown): LlmError {
  if (err instanceof ApiError) {
    // Keep the provider's reason (which quota: per minute or per day) for our log; users get a generic message.
    if (err.status === 429) return new LlmError('rate_limited', `AI quota or rate limit reached: ${err.message.slice(0, 500)}`);
    if (err.status === 408 || err.status === 504) return new LlmError('timeout', 'AI provider timed out');
    if (err.status >= 500) return new LlmError('unavailable', `AI provider error ${err.status}`);
    return new LlmError('bad_request', `AI request rejected (${err.status}): ${err.message}`);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/abort|timeout|timed out/i.test(message)) return new LlmError('timeout', 'AI provider timed out');
  return new LlmError('unavailable', `AI provider unreachable: ${message}`);
}
