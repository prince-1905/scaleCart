import { Logger } from '@nestjs/common';
import type { CartService } from '../cart/cart.service.js';
import type {
  CatalogService,
  ProductView,
} from '../catalog/catalog.service.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import { ShopTools } from './shop-tools.js';

const SHOES: ProductView = {
  id: 7,
  sku: 'DEMO-FW-001',
  name: 'Stride Lite Running Shoes',
  description: 'Lightweight running shoes',
  category: 'footwear',
  priceCents: 249_900,
};

function setup({ stock = 10, inCart = 0 } = {}) {
  const calls: { userId: string; productId: number; quantity: number }[] = [];
  const catalog = {
    search: vi.fn(async () => [SHOES]),
    getPublic: vi.fn(async (id: number) => (id === SHOES.id ? SHOES : null)),
    getById: vi.fn(async (id: number) => (id === SHOES.id ? SHOES : null)),
  };
  const inventory = {
    getAvailable: vi.fn(async (id: number) => (id === SHOES.id ? stock : null)),
  };
  const cart = {
    getLines: vi.fn(async () =>
      inCart ? [{ productId: SHOES.id, quantity: inCart }] : [],
    ),
    setQuantity: vi.fn(
      async (userId: string, productId: number, quantity: number) => {
        calls.push({ userId, productId, quantity });
      },
    ),
    view: vi.fn(async () => ({ items: [], totalCents: 0 })),
  };
  const orders = {
    get: vi.fn(async () => null),
    list: vi.fn(async () => ({ items: [] })),
  };
  const tools = new ShopTools(
    catalog as unknown as CatalogService,
    inventory as unknown as InventoryService,
    cart as unknown as CartService,
    orders as unknown as OrdersService,
  );
  return { tools, catalog, cart, orders, calls };
}

const ctx = { userId: 'user-a' };
const call = (name: string, args: Record<string, unknown>) => ({
  id: 'call_0',
  name,
  args,
});

describe('ShopTools', () => {
  it('describes 5 tools to the model as plain JSON Schema', () => {
    const { tools } = setup();
    expect(tools.specs.map((s) => s.name)).toEqual([
      'search_products',
      'get_product_details',
      'check_stock',
      'add_to_cart',
      'get_order_status',
    ]);
    const addToCart = tools.specs.find(
      (s) => s.name === 'add_to_cart',
    )!.parameters;
    expect(addToCart).toMatchObject({
      type: 'object',
      required: ['product_id', 'quantity'],
    });
    expect(addToCart).not.toHaveProperty('$schema');
  });

  it('converts rupees to paise for search and returns prices in ₹', async () => {
    const { tools, catalog } = setup();
    const out = await tools.run(
      call('search_products', { query: 'shoes', max_price: 3000 }),
      ctx,
    );

    expect(catalog.search).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'shoes', maxPriceCents: 300_000 }),
    );
    expect(out.ok).toBe(true);
    expect(out.content).toEqual({
      count: 1,
      products: [
        { id: 7, name: SHOES.name, category: 'footwear', price: '₹2,499' },
      ],
    });
    expect(out.cards).toEqual([
      { id: 7, name: SHOES.name, category: 'footwear', priceInr: 2499 },
    ]);
  });

  it('turns bad arguments into an error result the model can read, without running the tool', async () => {
    const { tools, cart } = setup();
    const tooMany = await tools.run(
      call('add_to_cart', { product_id: 7, quantity: 50 }),
      ctx,
    );
    expect(tooMany.ok).toBe(false);
    expect(JSON.stringify(tooMany.content)).toMatch(/quantity/);

    const unknownTool = await tools.run(call('checkout', {}), ctx);
    expect(unknownTool).toMatchObject({
      ok: false,
      content: { error: 'unknown tool "checkout"' },
    });
    expect(cart.setQuantity).not.toHaveBeenCalled();
  });

  it("ignores any user id the model tries to pass: it always uses the signed-in user's", async () => {
    const { tools, calls } = setup();
    const sneaky = await tools.run(
      call('add_to_cart', { product_id: 7, quantity: 1, user_id: 'user-b' }),
      ctx,
    );
    expect(sneaky.ok).toBe(false); // unknown fields are rejected outright

    const fine = await tools.run(
      call('add_to_cart', { product_id: '7', quantity: 2 }),
      ctx,
    );
    expect(fine.ok).toBe(true);
    expect(calls).toEqual([{ userId: 'user-a', productId: 7, quantity: 2 }]);
  });

  it('adds to the existing quantity and refuses more than the stock', async () => {
    const { tools, calls } = setup({ stock: 3, inCart: 2 });
    const tooMany = await tools.run(
      call('add_to_cart', { product_id: 7, quantity: 2 }),
      ctx,
    );
    expect(tooMany).toMatchObject({
      ok: false,
      content: { error: 'only 3 in stock' },
    });

    await tools.run(call('add_to_cart', { product_id: 7, quantity: 1 }), ctx);
    expect(calls).toEqual([{ userId: 'user-a', productId: 7, quantity: 3 }]);
  });

  it("reports another customer's order as not found", async () => {
    const { tools, orders } = setup();
    const id = '01970000-0000-7000-8000-000000000000';
    const out = await tools.run(
      call('get_order_status', { order_id: id }),
      ctx,
    );
    expect(orders.get).toHaveBeenCalledWith('user-a', id);
    expect(out).toMatchObject({
      ok: false,
      content: { error: `no order ${id} for this customer` },
    });
  });

  it('hides internal errors from the model, but logs them for us', async () => {
    const { tools, catalog } = setup();
    // Silenced here: the test checks the log line instead of printing it.
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    catalog.search.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 10.0.0.5:3306'),
    );
    const out = await tools.run(
      call('search_products', { query: 'shoes' }),
      ctx,
    );
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.content)).not.toMatch(/ECONNREFUSED|3306/);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/ECONNREFUSED/));
    log.mockRestore();
  });
});
