import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { DropsService } from './drops.service.js';

/** Every few seconds (DROP_STOCK_GATE_RESET_SECONDS), sets each live drop's Redis door counter to MySQL's real stock (see DropsService.resetGates). */
@Injectable()
export class StockGateReset implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(StockGateReset.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly drops: DropsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      this.drops.resetGates().catch((err) => this.logger.warn(`stock gate reset failed: ${(err as Error).message}`));
    }, this.env.dropStockGateResetSeconds * 1000);
    this.timer.unref();
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }
}
