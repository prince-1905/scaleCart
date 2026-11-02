/**
 * Step 1a: one plain call to the AI model through our wrapper. No tools, no app.
 *
 *   cd apps/api && node scripts/ai-hello.ts "your question"
 *
 * Reads GEMINI_API_KEY from the repo-root .env (never printed). Lab tool, not app code.
 */
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { GeminiClient, LlmError } from '../src/ai/llm-client.ts';

const DOT_ENV = new URL('../../../.env', import.meta.url);
if (existsSync(DOT_ENV)) process.loadEnvFile(DOT_ENV);
if (!process.env.GEMINI_API_KEY) throw new Error('Set GEMINI_API_KEY in the repo-root .env');

const client = new GeminiClient({
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.AI_MODEL ?? 'gemini-3.6-flash',
  timeoutMs: 30_000,
  thinkingLevel: (process.env.AI_THINKING_LEVEL ?? 'minimal') as 'minimal' | 'low',
});

const question = process.argv[2] ?? 'In one sentence: what is an e-commerce shopping cart?';
const started = performance.now();
try {
  const reply = await client.generate({
    system: 'You are a helpful assistant. Answer in at most two sentences.',
    turns: [{ role: 'user', text: question }],
  });
  console.log(`model:   ${client.model}`);
  console.log(`answer:  ${reply.turn.text}`);
  console.log(`finish:  ${reply.finishReason}`);
  console.log(
    `tokens:  ${reply.usage.inputTokens} in, ${reply.usage.outputTokens} out, ${reply.usage.thinkingTokens} thinking`,
  );
  console.log(`time:    ${Math.round(performance.now() - started)} ms`);
} catch (err) {
  if (err instanceof LlmError) console.error(`AI error [${err.kind}]: ${err.message}`);
  else throw err;
  process.exitCode = 1;
}
