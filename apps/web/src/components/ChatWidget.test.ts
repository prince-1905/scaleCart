import { describe, expect, it } from 'vitest';
import { readLines } from './ChatWidget';

/** A body that arrives in arbitrary chunks, like a real network stream. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

describe('readLines (NDJSON stream from /ai/chat/stream)', () => {
  it('yields one event per line, even when lines and characters are split across chunks', async () => {
    const text = '{"type":"tool_start","name":"search_products"}\n{"type":"reply","reply":"Stride Lite, ₹2,499","cards":[],"toolCalls":[]}\n';
    const bytes = new TextEncoder().encode(text);
    const rupee = text.indexOf('₹');
    const at = new TextEncoder().encode(text.slice(0, rupee)).length + 1; // cut inside the 3-byte ₹
    const events = [];
    for await (const e of readLines(streamOf([bytes.slice(0, 20), bytes.slice(20, at), bytes.slice(at)]))) events.push(e);

    expect(events).toEqual([
      { type: 'tool_start', name: 'search_products' },
      { type: 'reply', reply: 'Stride Lite, ₹2,499', cards: [], toolCalls: [] },
    ]);
  });
});
