/**
 * A small, realistic catalog (₹ prices, categories, varied stock) for demos and the AI
 * shopping assistant. Safe to run repeatedly: it updates the DEMO-* products and
 * resets their stock to the values below.
 *
 *   node dist/seed-demo.js
 *
 * Prices are stored in paise (₹1 = 100), like every price in the system.
 */
import { DataSource } from 'typeorm';
import { catalogDatabase } from './catalog/catalog.database.js';
import type { ProductCategory } from './catalog/catalog.dto.js';
import { loadDbConfig } from './config/env.js';
import { mysqlOptions, type ModuleDatabase } from './database/database.js';
import { inventoryDatabase } from './inventory/inventory.database.js';

type DemoProduct = [sku: string, category: ProductCategory, name: string, rupees: number, stock: number, description: string];

// prettier-ignore
const PRODUCTS: DemoProduct[] = [
  ['DEMO-FW-001', 'footwear', 'Stride Lite Running Shoes', 2499, 40, 'Lightweight running shoes with breathable mesh and a cushioned sole for daily runs and gym sessions.'],
  ['DEMO-FW-002', 'footwear', 'TrailGrip Hiking Shoes', 3799, 12, 'Waterproof hiking shoes with a rugged grip sole for treks and monsoon trails.'],
  ['DEMO-FW-003', 'footwear', 'Urban Canvas Sneakers', 1299, 60, 'Classic white canvas sneakers for everyday casual wear.'],
  ['DEMO-FW-004', 'footwear', 'Comfort Walk Sandals', 799, 0, 'Soft cushioned sandals for daily walking. Currently sold out.'],
  ['DEMO-FW-005', 'footwear', 'Pro Sprint Running Shoes', 5499, 3, 'Premium running shoes with carbon plate for race day and fast training runs.'],
  ['DEMO-EL-001', 'electronics', 'PulseFit Smartwatch', 1999, 25, 'Smartwatch with heart rate, sleep tracking, step counter and 7-day battery. A popular gift.'],
  ['DEMO-EL-002', 'electronics', 'BassBoom Wireless Earbuds', 1499, 80, 'True wireless earbuds with deep bass, 30-hour battery case and fast charging.'],
  ['DEMO-EL-003', 'electronics', 'SoundCube Bluetooth Speaker', 2299, 15, 'Portable waterproof Bluetooth speaker with 12-hour playtime, great for travel.'],
  ['DEMO-EL-004', 'electronics', 'QuietMax Noise Cancelling Headphones', 6999, 8, 'Over-ear wireless headphones with active noise cancellation and 40-hour battery.'],
  ['DEMO-EL-005', 'electronics', 'PowerGo 20000 mAh Power Bank', 1599, 50, 'Fast charging power bank for phones and earbuds, charges two devices at once.'],
  ['DEMO-EL-006', 'electronics', 'ClickPro Wireless Mouse', 599, 120, 'Silent wireless mouse with ergonomic grip for work and study.'],
  ['DEMO-FA-001', 'fashion', 'Classic Leather Wallet', 899, 35, 'Genuine leather bifold wallet with card slots and coin pocket. A classic gift for men.'],
  ['DEMO-FA-002', 'fashion', 'Cotton Kurta Set', 1799, 20, 'Comfortable cotton kurta with pyjama for festivals and family functions.'],
  ['DEMO-FA-003', 'fashion', 'Everyday Denim Jacket', 2599, 10, 'Blue denim jacket with a relaxed fit for casual winter evenings.'],
  ['DEMO-FA-004', 'fashion', 'Aviator Sunglasses', 1199, 0, 'UV protection aviator sunglasses with metal frame. Currently sold out.'],
  ['DEMO-FA-005', 'fashion', 'Travel Laptop Backpack', 1899, 30, 'Water resistant backpack with padded laptop sleeve and USB charging port.'],
  ['DEMO-HO-001', 'home', 'Aroma Scented Candle Set', 699, 45, 'Set of three soy scented candles: lavender, vanilla and sandalwood. A lovely gift.'],
  ['DEMO-HO-002', 'home', 'SoftNest Cotton Bedsheet', 1299, 25, 'King size cotton bedsheet with two pillow covers, soft and breathable.'],
  ['DEMO-HO-003', 'home', 'Desk Plant with Ceramic Pot', 499, 18, 'Low maintenance indoor plant in a white ceramic pot for desk or shelf.'],
  ['DEMO-KI-001', 'kitchen', 'BrewMaster French Press', 999, 22, 'Glass French press coffee maker, 600 ml, makes rich coffee in four minutes.'],
  ['DEMO-KI-002', 'kitchen', 'Steel Insulated Water Bottle', 649, 90, 'Stainless steel bottle keeps drinks cold for 24 hours and hot for 12 hours.'],
  ['DEMO-KI-003', 'kitchen', 'NonStick Cookware Set', 3499, 7, 'Three piece non-stick cookware set: kadai, frying pan and saucepan, induction friendly.'],
  ['DEMO-KI-004', 'kitchen', 'QuickBlend Mixer Grinder', 2999, 2, '750 watt mixer grinder with three jars for chutneys, masalas and juices.'],
  ['DEMO-BE-001', 'beauty', 'Herbal Face Wash', 249, 150, 'Gentle neem and tulsi face wash for daily use, suitable for oily skin.'],
  ['DEMO-BE-002', 'beauty', 'Beard Grooming Kit', 1099, 28, 'Beard oil, balm, comb and scissors in a gift box. A great gift for dad.'],
  ['DEMO-BE-003', 'beauty', 'Sunscreen SPF 50', 399, 0, 'Lightweight sunscreen with SPF 50 for everyday sun protection. Currently sold out.'],
  ['DEMO-SP-001', 'sports', 'FlexCore Yoga Mat', 899, 40, 'Anti-slip 6 mm yoga mat with carry strap for yoga, stretching and home workouts.'],
  ['DEMO-SP-002', 'sports', 'PowerGrip Dumbbell Pair 5 kg', 1499, 14, 'Pair of 5 kg rubber coated dumbbells for strength training at home.'],
  ['DEMO-SP-003', 'sports', 'Cricket Bat English Willow', 4999, 5, 'English willow cricket bat for leather ball matches, full size.'],
  ['DEMO-BO-001', 'books', 'The Systems Design Handbook', 799, 33, 'A practical book on designing scalable web systems: caching, queues and databases.'],
  ['DEMO-BO-002', 'books', 'Indian Kitchen Classics Cookbook', 599, 19, 'One hundred home style Indian recipes with simple steps. A thoughtful gift.'],
];

async function open(def: ModuleDatabase) {
  return new DataSource(mysqlOptions(loadDbConfig(), def, 2)).initialize();
}

const [catalog, inventory] = await Promise.all(
  [catalogDatabase, inventoryDatabase].map(open),
);
try {
  for (const [sku, category, name, rupees, , description] of PRODUCTS) {
    await catalog.query(
      `INSERT INTO products (sku, name, description, category, price_cents) VALUES (?, ?, ?, ?, ?) AS new
         ON DUPLICATE KEY UPDATE name = new.name, description = new.description,
           category = new.category, price_cents = new.price_cents`,
      [sku, name, description, category, rupees * 100],
    );
  }
  const ids: { id: number; sku: string }[] = await catalog.query(
    'SELECT id, sku FROM products WHERE sku IN (?)',
    [PRODUCTS.map((p) => p[0])],
  );
  const stockBySku = new Map(PRODUCTS.map((p) => [p[0], p[4]]));
  for (const { id, sku } of ids) {
    await inventory.query(
      `INSERT INTO stock (product_id, available) VALUES (?, ?) AS new
         ON DUPLICATE KEY UPDATE available = new.available`,
      [id, stockBySku.get(sku)],
    );
  }
  console.log(`demo products: ${ids.length} upserted (stock reset)`);
} finally {
  await Promise.all([catalog, inventory].map((ds) => ds.destroy()));
}
