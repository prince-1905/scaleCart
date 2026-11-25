import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

const BEAT_EVERY_MS = 250;

/**
 * Phase 13: stamps the primary's current time into `replication_heartbeat` every 250 ms (worker only, one writer).
 * The API reads the stamp from the replica to know how far behind it is (ReadReplica). If this stops (worker down),
 * the stamp ages, the replica looks "lagging" and reads go to the primary: the safe direction.
 */
@Injectable()
export class ReplicationHeartbeat implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ReplicationHeartbeat.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  private failing = false;

  constructor(@InjectDataSource('orders') private readonly db: DataSource) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.beat(), BEAT_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  async beat() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.db.query(
        'INSERT INTO replication_heartbeat (id, beat_at) VALUES (1, UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE beat_at = UTC_TIMESTAMP(6)',
      );
      if (this.failing) this.logger.log('heartbeat written again');
      this.failing = false;
    } catch (err) {
      if (!this.failing) this.logger.warn(`heartbeat failed: ${(err as Error).message}`);
      this.failing = true;
    } finally {
      this.busy = false;
    }
  }
}
