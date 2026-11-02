import type { INestApplication } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { HttpAdapterName } from '../src/config/env.js';
import { createProduct, http, registerAdmin, startApp, unique } from './support.js';

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };
/** Tool results come back as JSON text. */
const parse = (result: unknown) => JSON.parse((result as TextResult).content[0].text) as Record<string, unknown>;

// A real MCP client from the official SDK, talking the real protocol over HTTP.
// No GEMINI_API_KEY in these apps: the MCP server doesn't need one.
describe.each<HttpAdapterName>(['fastify', 'express'])('MCP server on %s', (adapter) => {
  let app: INestApplication;
  let client: Client;
  const word = unique('mcpz').replace('-', '');
  let shoe: number;

  beforeAll(async () => {
    app = await startApp(adapter);
    const admin = await registerAdmin(app);
    shoe = await createProduct(app, admin, {
      name: `${word} trail shoe`,
      priceCents: 249_900,
      category: 'footwear',
      stock: 3,
    });
    client = new Client({ name: 'e2e-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${await app.getUrl()}/mcp`)));
  });

  afterAll(async () => {
    await client.close();
    await app.close();
  });

  it('introduces itself and offers only the 3 read-only tools', async () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'scalecart' });
    expect(client.getInstructions()).toMatch(/read its public catalog/);

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(['check_stock', 'get_product_details', 'search_products']);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true });
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('searches, reads and checks stock against the real shop, without logging in', async () => {
    const search = await client.callTool({ name: 'search_products', arguments: { query: word } });
    expect(search.isError).toBe(false);
    expect(parse(search)).toEqual({
      count: 1,
      products: [{ id: shoe, name: `${word} trail shoe`, category: 'footwear', price: '₹2,499' }],
    });

    const details = await client.callTool({ name: 'get_product_details', arguments: { product_id: shoe } });
    expect(parse(details)).toMatchObject({ id: shoe, price: '₹2,499' });

    const stock = await client.callTool({ name: 'check_stock', arguments: { product_id: shoe } });
    expect(parse(stock)).toEqual({ product_id: shoe, available: 3, status: 'low_stock' });
  });

  it('reports bad input as a tool error the calling model can fix', async () => {
    const res = await client.callTool({ name: 'check_stock', arguments: { product_id: 'abc' } });

    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/invalid arguments/);
  });

  it("can't reach cart or order tools, even by name", async () => {
    for (const name of ['add_to_cart', 'get_order_status']) {
      const res = await client.callTool({ name, arguments: { product_id: shoe, quantity: 1 } });
      expect(res.isError).toBe(true);
      expect(parse(res)).toEqual({ error: `unknown tool "${name}"` });
    }
  });

  it('answers GET and DELETE with 405: a stateless server has no stream or session', async () => {
    await http(app).get('/mcp').expect(405);
    await http(app).delete('/mcp').expect(405);
  });
});
