import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { connect, type ChannelModel, type ConfirmChannel, type ConsumeMessage, type Options } from 'amqplib';
import { setTimeout as sleep } from 'node:timers/promises';
import { ENV, type Env } from '../config/env.js';
import { MetricsService } from '../observability/metrics.service.js';
import { assertTopology, topology, type Topology } from './topology.js';

export type MessageHandler = (msg: ConsumeMessage, reply: { ack(): void; nack(requeue: boolean): void }) => Promise<void>;

interface Consumer {
  queue: string;
  prefetch: number;
  handler: MessageHandler;
}

/**
 * One RabbitMQ connection per process, reconnecting forever with backoff.
 *
 * - Publishing uses a *confirm channel*: RabbitMQ acknowledges each message once it
 *   is safely stored. Until then we treat it as not sent.
 * - Consumers are remembered and re-attached after every reconnect.
 * - Topology (exchange, queues) is declared on every connect, so a fresh broker works.
 */
@Injectable()
export class RabbitService implements OnApplicationShutdown {
  private readonly logger = new Logger(RabbitService.name);
  readonly names: Topology;
  private model?: ChannelModel;
  private publisher?: ConfirmChannel;
  private readonly consumers: Consumer[] = [];
  private stopped = false;
  private connecting?: Promise<void>;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly metrics: MetricsService,
  ) {
    this.names = topology(env.mqPrefix);
  }

  get isReady(): boolean {
    return this.publisher !== undefined;
  }

  /** Connects in the background; resolves once connected (or when shut down). */
  start(): Promise<void> {
    this.connecting ??= this.connectLoop().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  async consume(queue: string, prefetch: number, handler: MessageHandler): Promise<void> {
    const consumer = { queue, prefetch, handler };
    this.consumers.push(consumer);
    if (this.model) await this.attach(this.model, consumer);
  }

  /** Publishes an event to the topic exchange. Call `confirm()` before trusting it was stored. */
  publishEvent(routingKey: string, body: unknown, options: Options.Publish): void {
    this.channel().publish(this.names.events, routingKey, Buffer.from(JSON.stringify(body)), {
      persistent: true,
      contentType: 'application/json',
      ...options,
    });
  }

  /** Sends straight to one queue (default exchange): used for retry and dead-letter queues. */
  sendToQueue(queue: string, content: Buffer, options: Options.Publish): void {
    this.channel().sendToQueue(queue, content, { persistent: true, ...options });
  }

  /** Waits until RabbitMQ has stored every message published so far; throws if any was refused. */
  async confirm(): Promise<void> {
    await this.channel().waitForConfirms();
  }

  async onApplicationShutdown() {
    this.stopped = true;
    await this.model?.close().catch(() => {});
  }

  private channel(): ConfirmChannel {
    if (!this.publisher) throw new Error('RabbitMQ is not connected');
    return this.publisher;
  }

  private async connectLoop(): Promise<void> {
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        const model = await connect(this.env.rabbitmqUrl);
        model.on('error', (err) => this.logger.warn(`rabbitmq connection error: ${err.message}`));
        model.on('close', () => this.onDisconnect(model));

        const publisher = await model.createConfirmChannel();
        // A channel-level error (e.g. a refused declaration) closes the channel; restart cleanly.
        publisher.on('close', () => void model.close().catch(() => {}));
        await assertTopology(publisher, this.names);

        this.model = model;
        this.publisher = publisher;
        for (const c of this.consumers) await this.attach(model, c);
        this.metrics.rabbitConnected.set(1);
        this.logger.log('connected to rabbitmq');
        return;
      } catch (err) {
        const wait = Math.min(250 * 2 ** attempt, 5_000);
        this.logger.warn(`rabbitmq unavailable (${(err as Error).message}); retrying in ${wait} ms`);
        await sleep(wait);
      }
    }
  }

  private onDisconnect(model: ChannelModel) {
    if (this.model !== model) return;
    this.model = undefined;
    this.publisher = undefined;
    this.metrics.rabbitConnected.set(0);
    if (!this.stopped) {
      this.logger.warn('rabbitmq connection lost; reconnecting');
      void this.start();
    }
  }

  private async attach(model: ChannelModel, { queue, prefetch, handler }: Consumer) {
    const ch = await model.createChannel();
    ch.on('close', () => void model.close().catch(() => {}));
    // At most `prefetch` unacknowledged messages per consumer: back-pressure, so a slow
    // email server can't make RabbitMQ push the whole queue into this process.
    await ch.prefetch(prefetch);
    await ch.consume(queue, (msg) => {
      if (!msg) return; // consumer cancelled by the broker
      const reply = { ack: () => ch.ack(msg), nack: (requeue: boolean) => ch.nack(msg, false, requeue) };
      handler(msg, reply).catch((err) => {
        this.logger.error(`unhandled error in ${queue} handler: ${(err as Error).message}`);
        reply.nack(true);
      });
    });
  }
}
