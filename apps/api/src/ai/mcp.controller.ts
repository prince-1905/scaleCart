import { Controller, Delete, Get, Logger, Post, Req, Res } from '@nestjs/common';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Public } from '../common/auth.js';
import { ShopTools } from './shop-tools.js';

/** Fastify wraps Node's request/response (`.raw`); Express passes them through. */
type AnyRequest = IncomingMessage & { raw?: IncomingMessage; body?: unknown };
type AnyResponse = ServerResponse & { raw?: ServerResponse; hijack?: () => void };

const INSTRUCTIONS =
  'ScaleCart is a demo online store in India. These tools read its public catalog: search products, ' +
  'read one product, and check stock. Prices are in rupees. Nothing here can change a cart or place an order.';

/**
 * MCP server (Model Context Protocol) at POST /mcp, "Streamable HTTP" transport.
 *
 * Any MCP client (Claude Code, Claude Desktop, Cursor…) can discover and call the shop's read-only
 * tools. It reuses the chat assistant's tools, so there is one implementation of each. No login and
 * no Gemini key: the client brings its own model, and these tools only read public data.
 *
 * Stateless: every request gets a fresh server, nothing is remembered between requests, so any API
 * replica behind the load balancer can answer.
 */
@Public()
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(private readonly tools: ShopTools) {}

  @Post()
  async handle(@Req() req: AnyRequest, @Res() res: AnyResponse): Promise<void> {
    const nodeRes = res.raw ?? res;
    res.hijack?.(); // Fastify: we write the response ourselves
    const server = this.createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    nodeRes.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw ?? req, nodeRes, req.body);
  }

  /** Stateless servers have no session to stream to (GET) or end (DELETE). */
  @Get()
  stream(@Res() res: AnyResponse): void {
    notAllowed(res);
  }

  @Delete()
  endSession(@Res() res: AnyResponse): void {
    notAllowed(res);
  }
  private createServer(): Server {
    const server = new Server(
      { name: 'scalecart', version: '1.0.0' },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.tools.publicSpecs.map(
        (spec): Tool => ({
          name: spec.name,
          description: spec.description,
          inputSchema: spec.parameters as Tool['inputSchema'],
          annotations: { readOnlyHint: true, openWorldHint: false },
        }),
      ),
    }));

    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const started = Date.now();
      const outcome = await this.tools.runPublic({ id: 'mcp', name: params.name, args: params.arguments ?? {} });
      const text = JSON.stringify(outcome.content);
      this.logger.log(
        `mcp tool ${params.name} ${JSON.stringify(params.arguments ?? {})} → ` +
          `${outcome.ok ? 'ok' : `error ${text.slice(0, 300)}`} (${Date.now() - started} ms)`,
      );
      // isError: the calling model sees the failure and can correct itself, like our own loop does.
      return { content: [{ type: 'text', text }], isError: !outcome.ok };
    });

    return server;
  }
}

function notAllowed(res: AnyResponse): void {
  const nodeRes = res.raw ?? res;
  res.hijack?.();
  nodeRes.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
  nodeRes.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
}
