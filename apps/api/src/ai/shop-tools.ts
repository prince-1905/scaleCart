import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { MAX_QUANTITY_PER_LINE, CartService } from '../cart/cart.service.js';
import { PRODUCT_CATEGORIES, PRODUCT_SORTS } from '../catalog/catalog.dto.js';
import {
  CatalogService,
  type ProductView,
} from '../catalog/catalog.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { OrdersService } from '../orders/orders.service.js';
import type { ToolCall, ToolSpec } from './llm-client.js';

/**
 * Who is asking. Comes from the verified JWT, never from the model: whatever the
 * conversation says, add_to_cart and get_order_status only touch this user's data.
 */
export interface ToolContext {
  userId: string;
}

/** A product the chat widget shows as a clickable card. */
export interface ProductCard {
  id: number;
  name: string;
  category: string | null;
  priceInr: number;
}

export interface ToolOutcome {
  ok: boolean;
  /** What the model reads: the result, or an error message it can act on. */
  content: unknown;
  cards: ProductCard[];
}

/** An expected failure (not found, out of stock…). Its message goes to the model as is. */
class ToolError extends Error {}

const LOW_STOCK = 5;
const SEARCH_LIMIT = 5;

/** Tools that only read public catalog data: safe to offer without a signed-in user (the MCP server). */
export const PUBLIC_TOOLS: readonly string[] = ['search_products', 'get_product_details', 'check_stock'];
/** Public tools never read the user, so they get nobody. */
const NO_USER: ToolContext = { userId: '' };

const inr = (paise: number) => paise / 100;
const formatInr = (paise: number) =>
  `₹${inr(paise).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const card = (p: ProductView): ProductCard => ({
  id: p.id,
  name: p.name,
  category: p.category,
  priceInr: inr(p.priceCents),
});

// Models sometimes send numbers as strings ("201037"): accept both, reject anything else.
const productId = z.coerce
  .number()
  .int()
  .positive()
  .describe('Product id from search_products');

// One schema per tool: it becomes the JSON Schema the model reads AND checks what the model sends.
const searchArgs = z
  .object({
    query: z
      .string()
      .max(100)
      .optional()
      .describe(
        '1-3 keywords from the product name, e.g. "running shoes". Omit to browse a category.',
      ),
    category: z.enum(PRODUCT_CATEGORIES).optional(),
    min_price: z.number().min(0).optional().describe('Minimum price in rupees'),
    max_price: z
      .number()
      .positive()
      .optional()
      .describe('Maximum price in rupees'),
    sort: z.enum(PRODUCT_SORTS).optional().describe('Default: relevance'),
  })
  .strict();
const productArgs = z.object({ product_id: productId }).strict();
const addToCartArgs = z
  .object({
    product_id: productId,
    quantity: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_QUANTITY_PER_LINE)
      .describe('How many to add'),
  })
  .strict();
const orderArgs = z
  .object({
    order_id: z
      .uuid()
      .optional()
      .describe(
        "The order id. Omit to get the customer's 3 most recent orders.",
      ),
  })
  .strict();

interface ShopTool<S extends z.ZodType> {
  description: string;
  args: S;
  run(
    args: z.infer<S>,
    ctx: ToolContext,
  ): Promise<{ content: unknown; cards?: ProductCard[] }>;
}

/**
 * The assistant's tools. Each one is a thin adapter over an existing module service:
 * no new business logic, no direct database access.
 */
@Injectable()
export class ShopTools {
  private readonly logger = new Logger(ShopTools.name);
  private readonly tools: Record<string, ShopTool<z.ZodType>>;
  readonly specs: ToolSpec[];
  readonly publicSpecs: ToolSpec[];

  constructor(
    private readonly catalog: CatalogService,
    private readonly inventory: InventoryService,
    private readonly cart: CartService,
    private readonly orders: OrdersService,
  ) {
    this.tools = {
      search_products: tool({
        description:
          "Search this store's catalog. Returns up to 5 products with id, name, category and price in rupees. " +
          'Use it before recommending anything; never invent products or prices.',
        args: searchArgs,
        run: (a) => this.searchProducts(a),
      }),
      get_product_details: tool({
        description:
          'Full details of one product: name, category, price and description.',
        args: productArgs,
        run: (a) => this.productDetails(a.product_id),
      }),
      check_stock: tool({
        description: 'How many units of a product are available right now.',
        args: productArgs,
        run: (a) => this.checkStock(a.product_id),
      }),
      add_to_cart: tool({
        description:
          "Add a product to the signed-in customer's cart. Only when the customer clearly asked to add it. " +
          'Returns the updated cart.',
        args: addToCartArgs,
        run: (a, ctx) => this.addToCart(ctx.userId, a.product_id, a.quantity),
      }),
      get_order_status: tool({
        description:
          "Status of one of the signed-in customer's orders, or their 3 most recent orders.",
        args: orderArgs,
        run: (a, ctx) => this.orderStatus(ctx.userId, a.order_id),
      }),
    };
    this.specs = Object.entries(this.tools).map(([name, t]) => ({
      name,
      description: t.description,
      parameters: toJsonSchema(t.args),
    }));
    this.publicSpecs = this.specs.filter((s) => PUBLIC_TOOLS.includes(s.name));
  }

  /** For callers without a user: anything outside PUBLIC_TOOLS looks like it doesn't exist. */
  runPublic(call: ToolCall): Promise<ToolOutcome> {
    if (!PUBLIC_TOOLS.includes(call.name)) return Promise.resolve(failure(`unknown tool "${call.name}"`));
    return this.run(call, NO_USER);
  }

  /** Validates the model's arguments, runs the tool, and never throws: failures become results. */
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools[call.name];
    if (!tool) return failure(`unknown tool "${call.name}"`);

    const parsed = tool.args.safeParse(call.args);
    if (!parsed.success)
      return failure(`invalid arguments: ${z.prettifyError(parsed.error)}`);

    try {
      const { content, cards = [] } = await tool.run(parsed.data, ctx);
      return { ok: true, content, cards };
    } catch (err) {
      if (err instanceof ToolError) return failure(err.message);
      // Unexpected (database down…): log the details, tell the model only that it failed.
      this.logger.error(
        `tool ${call.name} failed: ${(err as Error).stack ?? String(err)}`,
      );
      return failure(
        'the store system had a temporary problem; tell the customer to try again shortly',
      );
    }
  }

  private async searchProducts(a: z.infer<typeof searchArgs>) {
    const products = await this.catalog.search({
      q: a.query,
      category: a.category,
      minPriceCents:
        a.min_price === undefined ? undefined : Math.round(a.min_price * 100),
      maxPriceCents:
        a.max_price === undefined ? undefined : Math.round(a.max_price * 100),
      sort: a.sort ?? 'relevance',
      limit: SEARCH_LIMIT,
    });
    return {
      // Only what the model needs to choose: full descriptions cost tokens, get_product_details has them.
      content: {
        count: products.length,
        products: products.map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category,
          price: formatInr(p.priceCents),
        })),
      },
      cards: products.map(card),
    };
  }

  private async productDetails(id: number) {
    const p = await this.catalog.getPublic(id);
    if (!p?.category) throw new ToolError(`no product with id ${id}`);
    return {
      content: {
        id: p.id,
        name: p.name,
        category: p.category,
        price: formatInr(p.priceCents),
        description: p.description,
      },
      cards: [card(p)],
    };
  }

  private async checkStock(id: number) {
    const available = await this.inventory.getAvailable(id);
    if (available === null) throw new ToolError(`no product with id ${id}`);
    const status =
      available === 0
        ? 'out_of_stock'
        : available <= LOW_STOCK
          ? 'low_stock'
          : 'in_stock';
    return { content: { product_id: id, available, status } };
  }

  private async addToCart(userId: string, id: number, quantity: number) {
    const product = await this.catalog.getById(id);
    if (!product?.category) throw new ToolError(`no product with id ${id}`);

    const current =
      (await this.cart.getLines(userId)).find((l) => l.productId === id)
        ?.quantity ?? 0;
    const wanted = current + quantity;
    if (wanted > MAX_QUANTITY_PER_LINE) {
      throw new ToolError(
        `the cart already has ${current}; at most ${MAX_QUANTITY_PER_LINE} per product`,
      );
    }
    // Checked, not reserved: stock is only taken at checkout (two carts may hold the last unit).
    const available = (await this.inventory.getAvailable(id)) ?? 0;
    if (available < wanted) throw new ToolError(`only ${available} in stock`);

    await this.cart.setQuantity(userId, id, wanted);
    const cart = await this.cart.view(userId);
    return {
      content: {
        added: { product_id: id, name: product.name, quantity },
        cart: {
          items: cart.items.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            line_total: formatInr(i.lineTotalCents),
          })),
          total: formatInr(cart.totalCents),
        },
      },
      cards: [card(product)],
    };
  }

  private async orderStatus(userId: string, orderId?: string) {
    if (!orderId) {
      const { items } = await this.orders.list(userId, 3);
      return {
        content: {
          orders: items.map((o) => ({
            id: o.id,
            status: o.status,
            total: formatInr(o.totalCents),
            placed_at: o.createdAt,
          })),
        },
      };
    }
    // OrdersService filters by user too: someone else's order id looks exactly like a missing one.
    const order = await this.orders.get(userId, orderId);
    if (!order) throw new ToolError(`no order ${orderId} for this customer`);
    return {
      content: {
        id: order.id,
        status: order.status,
        total: formatInr(order.totalCents),
        placed_at: order.createdAt,
        items: order.items.map((i) => ({ name: i.name, quantity: i.quantity })),
      },
    };
  }
}

/** Keeps each tool's `args` and `run` types linked. */
function tool<S extends z.ZodType>(t: ShopTool<S>): ShopTool<z.ZodType> {
  return t as unknown as ShopTool<z.ZodType>;
}

function failure(message: string): ToolOutcome {
  return { ok: false, content: { error: message }, cards: [] };
}

/** zod → plain JSON Schema for the model. `io: 'input'` describes what the model may send. */
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    io: 'input',
  });
  return json;
}
