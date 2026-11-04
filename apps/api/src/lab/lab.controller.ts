import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { setTimeout as sleep } from 'node:timers/promises';
import { Public } from '../common/auth.js';

const MAX_MS = 1000;

function parseMs(raw: string | undefined): number {
  const ms = Number(raw ?? 0);
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_MS) {
    throw new BadRequestException(`ms must be between 0 and ${MAX_MS}`);
  }
  return ms;
}

/**
 * Endpoints that exist only for performance experiments (enabled with LAB_ENDPOINTS=true).
 * They isolate one behaviour each so its effect on the event loop can be measured.
 */
@Public()
@Controller('lab')
export class LabController {
  constructor(@InjectDataSource('inventory') private readonly inventory: DataSource) {}

  /**
   * Holds one product's stock row locked for `ms` (max 15 s), like a commit stuck on a slow
   * disk (E3e): every checkout of that product waits behind it. Makes a stall repeatable,
   * so a design can be tested against the same stall every time (experiment E5).
   */
  @Post('hold-stock-lock')
  async holdStockLock(@Query('productId') productId?: string, @Query('ms') ms?: string) {
    const id = Number(productId);
    const holdMs = Number(ms ?? 0);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('productId is required');
    if (!Number.isFinite(holdMs) || holdMs < 0 || holdMs > 15_000) {
      throw new BadRequestException('ms must be between 0 and 15000');
    }
    // performance.now(), not Date.now(): durations must not jump when the wall clock is corrected.
    const started = performance.now();
    let locked = started;
    await this.inventory.transaction(async (m) => {
      // May first wait behind checkouts that hold the row right now.
      await m.query('SELECT available FROM stock WHERE product_id = ? FOR UPDATE', [id]);
      locked = performance.now();
      await sleep(holdMs);
    });
    return { productId: id, lockWaitMs: Math.round(locked - started), heldMs: Math.round(performance.now() - locked) };
  }

  /** Near-zero work: measures pure framework + network overhead. */
  @Get('ping')
  ping() {
    return { ok: true };
  }

  /**
   * Waits without blocking, like a database or HTTP call would. While one request
   * waits, the event loop is free to serve thousands of others.
   */
  @Get('io')
  async io(@Query('ms') ms?: string) {
    const waitMs = parseMs(ms);
    await sleep(waitMs);
    return { waitedMs: waitMs };
  }

  /**
   * Burns CPU on the single JavaScript thread. While it runs, this process can do
   * nothing else, so one process tops out at roughly 1000 / ms requests per second.
   *
   * Measures this thread's CPU time, not wall-clock time: if the container is
   * throttled mid-request, wall time passes without work, and a wall-clock loop
   * would silently do less work per request.
   */
  @Get('cpu')
  cpu(@Query('ms') ms?: string) {
    const burnMicros = parseMs(ms) * 1000;
    const start = process.threadCpuUsage();
    let iterations = 0;
    for (;;) {
      const used = process.threadCpuUsage(start);
      if (used.user + used.system >= burnMicros) break;
      iterations++;
    }
    return { burnedMs: burnMicros / 1000, iterations };
  }
}
