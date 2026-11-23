import { Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConsumeMessage } from 'amqplib';
import { Repository } from 'typeorm';
import { moduleTypeOrm } from '../../database/module-typeorm.js';
import { MessagingModule } from '../../messaging/messaging.module.js';
import { RabbitService } from '../../messaging/rabbit.service.js';
import { MetricsService } from '../../observability/metrics.service.js';
import { ObservabilityModule } from '../../observability/observability.module.js';
import { catalogDatabase } from '../catalog.database.js';
import { PRODUCT_CHANGED, type ProductChangedEvent } from '../events.js';
import { Product } from '../product.entity.js';
import { ProductSearchIndex, toDocument } from './product-search-index.js';

const ATTEMPT_HEADER = 'x-attempt';
const MAX_ATTEMPTS = 12;
type Reply = { ack(): void; nack(requeue: boolean): void };

/**
 * Keeps the search copy in step with MySQL (Phase 12, the "projection" of CQRS). Runs in the worker.
 *
 * For each product.changed event it reads the product's LATEST row from MySQL and writes that to OpenSearch (or
 * removes the document when the product is gone). Because it never trusts the event's own snapshot:
 *   - a duplicate event writes the same document again (idempotent)
 *   - two events handled out of order both write the latest row, so no old version can win
 * OpenSearch down → the message waits in the retry queue (5 s) and is tried again, up to 12 times.
 */
@Injectable()
export class ProductIndexer implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProductIndexer.name);

  constructor(
    @InjectRepository(Product, 'catalog') private readonly products: Repository<Product>,
    private readonly index: ProductSearchIndex,
    private readonly rabbit: RabbitService,
    private readonly metrics: MetricsService,
  ) {}

  async onApplicationBootstrap() {
    await this.index.ensureIndex().catch((err) => this.logger.warn(`search index not ready yet: ${(err as Error).message}`));
    void this.rabbit.start();
    await this.rabbit.consume(this.rabbit.names.searchProducts, 20, (msg, reply) => this.handle(msg, reply));
  }

  async handle(msg: ConsumeMessage, reply: Reply): Promise<void> {
    let event: ProductChangedEvent;
    try {
      event = JSON.parse(msg.content.toString('utf8'));
      if (msg.properties.type !== PRODUCT_CHANGED || !Number.isInteger(event.productId)) throw new Error('unknown event');
    } catch {
      await this.forward(`${this.rabbit.names.searchProducts}.dlq`, msg, { 'x-failure-reason': 'unparseable' }, reply);
      this.metrics.searchIndexing.inc({ result: 'dead_lettered' });
      return;
    }

    try {
      const result = await this.apply(event.productId);
      this.metrics.searchIndexing.inc({ result });
      const createdMs = Number(msg.properties.headers?.['x-created-ms']);
      if (createdMs > 0) this.metrics.searchIndexLag.observe(Math.max(0, Date.now() - createdMs) / 1000);
      reply.ack();
    } catch (err) {
      const attempt = Number(msg.properties.headers?.[ATTEMPT_HEADER] ?? 1);
      this.logger.warn(`product ${event.productId}: indexing attempt ${attempt} failed: ${(err as Error).message}`);
      const dead = attempt >= MAX_ATTEMPTS;
      const queue = `${this.rabbit.names.searchProducts}${dead ? '.dlq' : '.retry'}`;
      await this.forward(queue, msg, dead ? { 'x-failure-reason': (err as Error).message } : { [ATTEMPT_HEADER]: attempt + 1 }, reply);
      this.metrics.searchIndexing.inc({ result: dead ? 'dead_lettered' : 'retried' });
    }
  }

  /** Exposed for tests: copy one product's current state into the index. */
  async apply(productId: number): Promise<'indexed' | 'removed'> {
    const product = await this.products.findOneBy({ id: productId });
    if (!product) {
      await this.index.remove(productId);
      return 'removed';
    }
    await this.index.put(
      toDocument({
        id: product.id,
        sku: product.sku,
        name: product.name,
        description: product.description,
        category: product.category,
        priceCents: product.priceCents,
      }),
    );
    return 'indexed';
  }

  /** Copy to another queue, wait until RabbitMQ stored it, then ack the original (or requeue it if the copy failed). */
  private async forward(queue: string, msg: ConsumeMessage, headers: Record<string, unknown>, reply: Reply) {
    try {
      this.rabbit.sendToQueue(queue, msg.content, {
        messageId: msg.properties.messageId,
        type: msg.properties.type,
        contentType: msg.properties.contentType,
        timestamp: msg.properties.timestamp,
        headers: { ...msg.properties.headers, ...headers },
      });
      await this.rabbit.confirm();
      reply.ack();
    } catch {
      reply.nack(true);
    }
  }
}

/**
 * What the worker needs from the catalog (Phase 12): its database (the relay also empties the catalog outbox; the
 * DataSource is global once opened) and the indexer with the search index. No HTTP, no Redis.
 */
@Module({
  imports: [...moduleTypeOrm(catalogDatabase), ObservabilityModule, MessagingModule],
  providers: [ProductSearchIndex, ProductIndexer],
  exports: [ProductSearchIndex],
})
export class CatalogDataModule {}
