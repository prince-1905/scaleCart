import { Logger } from '@nestjs/common';
import { LlmError, type LlmClient, type LlmReply, type LlmRequest } from './llm-client.js';
import { MAX_ATTEMPTS, ProductCopywriter, productCopySchema, type ProductCopy } from './product-copywriter.js';

const usage = { inputTokens: 100, outputTokens: 50, thinkingTokens: 0 };
const say = (text: string): LlmReply => ({
  turn: { role: 'model', text, toolCalls: [] },
  finishReason: 'STOP',
  usage,
});

const GOOD: ProductCopy = {
  title: 'Stride Lite Running Shoes',
  short_description: 'Light, breathable running shoes for daily road runs.',
  long_description:
    'Stride Lite is made for runners who want a light shoe for everyday road miles. The breathable mesh upper keeps ' +
    'your feet cool in warm weather, and at 280 g it stays out of the way on longer runs and quick weekday sessions.',
  bullet_features: ['Breathable mesh upper', 'Weighs 280 g', 'Available in sizes 6 to 11'],
  seo_meta_title: 'Stride Lite Running Shoes',
  seo_meta_description: 'Light, breathable Stride Lite running shoes in sizes 6 to 11, made for daily road runs.',
  tags: ['running shoes', 'footwear', 'breathable'],
};
const json = (copy: unknown) => say(JSON.stringify(copy));

const FACTS = { name: 'Stride Lite Running Shoes', category: 'footwear', notes: 'breathable mesh, 280 g, sizes 6-11' };

function setup(...replies: LlmReply[]) {
  const requests: LlmRequest[] = [];
  const generate = vi.fn(async (req: LlmRequest) => {
    requests.push({ ...req, turns: [...req.turns] }); // copy: the retry appends to turns
    const next = replies.shift();
    if (!next) throw new Error('fake model ran out of replies');
    return next;
  });
  const llm: LlmClient = { model: 'fake-model', generate };
  return { writer: new ProductCopywriter(llm), requests, generate };
}

describe('ProductCopywriter (structured output)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns valid copy on the first attempt, and asks for JSON of the right shape', async () => {
    const { writer, requests } = setup(json(GOOD));

    const out = await writer.write(FACTS);

    expect(out).toMatchObject({
      copy: GOOD,
      attempts: 1,
      stats: { model: 'fake-model', inputTokens: 100, outputTokens: 50 },
    });
    expect(requests[0].jsonSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining(['title', 'bullet_features', 'tags']),
    });
    expect(requests[0].jsonSchema).not.toHaveProperty('$schema');
    expect(requests[0].tools).toBeUndefined();
  });

  it('gives the model only the facts it was given', async () => {
    const { writer, requests } = setup(json(GOOD), json(GOOD));

    await writer.write(FACTS);
    await writer.write({ name: 'Plain Mug', category: 'kitchen' });

    expect(requests[0].turns[0]).toMatchObject({ text: expect.stringContaining('breathable mesh, 280 g') });
    expect(requests[1].turns[0]).toMatchObject({ text: expect.stringMatching(/Plain Mug[\s\S]*\(none/) });
    expect(requests[0].system).toMatch(/never invent/i);
  });

  it('retries once when the output is not JSON', async () => {
    const { writer, requests } = setup(say('Sure! Here is your copy.'), json(GOOD));

    const out = await writer.write(FACTS);

    expect(out.attempts).toBe(2);
    expect(out.stats.inputTokens).toBe(200);
    expect(requests[1].turns.map((t) => t.role)).toEqual(['user', 'model', 'user']);
    expect(requests[1].turns[2]).toMatchObject({ text: expect.stringContaining('not valid JSON') });
  });

  it('tells the model exactly which rule failed when retrying', async () => {
    const { writer, requests } = setup(json({ ...GOOD, title: 'Only ₹2,499 running shoes' }), json(GOOD));

    const out = await writer.write(FACTS);

    expect(out.copy.title).toBe(GOOD.title);
    expect(requests[1].turns[2]).toMatchObject({
      text: expect.stringMatching(/must not mention prices[\s\S]*at title/),
    });
  });

  it('gives up after the second invalid answer', async () => {
    const { writer, generate } = setup(say('nope'), json({ ...GOOD, tags: [] }));

    await expect(writer.write(FACTS)).rejects.toMatchObject({ name: 'LlmError', kind: 'invalid_output' });
    expect(generate).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('does not retry provider errors: another call would not fix a quota or an outage', async () => {
    const { writer, generate } = setup();
    generate.mockRejectedValueOnce(new LlmError('rate_limited', 'quota'));

    await expect(writer.write(FACTS)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  describe('the schema', () => {
    const accepts = (copy: unknown) => productCopySchema.safeParse(copy).success;

    it('accepts good copy and tidies whitespace and tag case', () => {
      const parsed = productCopySchema.parse({ ...GOOD, title: `  ${GOOD.title} `, tags: ['Running Shoes', 'a1', 'b-2'] });
      expect(parsed.title).toBe(GOOD.title);
      expect(parsed.tags).toEqual(['running shoes', 'a1', 'b-2']);
    });

    it.each([
      ['an unknown field', { ...GOOD, price: 2499 }],
      ['a missing field', { ...GOOD, title: undefined }],
      ['a long SEO title', { ...GOOD, seo_meta_title: 'x'.repeat(61) }],
      ['a short long_description', { ...GOOD, long_description: 'Too short.' }],
      ['too few bullets', { ...GOOD, bullet_features: ['Breathable mesh'] }],
      ['too many tags', { ...GOOD, tags: Array.from({ length: 9 }, (_, i) => `tag ${i}`) }],
      ['a tag with symbols', { ...GOOD, tags: ['running', 'shoes', '#sale!'] }],
      ['a rupee sign', { ...GOOD, short_description: 'Great daily running shoes for only ₹2,499 today.' }],
      ['"Rs" and a number', { ...GOOD, bullet_features: ['Mesh upper', 'Worth Rs. 2499', 'Weighs 280 g'] }],
      ['the word rupees', { ...GOOD, seo_meta_title: 'Running shoes under 3000 rupees' }],
    ])('rejects %s', (_name, copy) => {
      expect(accepts(copy)).toBe(false);
    });

    it('does not mistake ordinary words for prices', () => {
      expect(accepts({ ...GOOD, short_description: 'Hers and his: running shoes in sizes 6 to 11 for road runs.' })).toBe(true);
    });
  });
});
