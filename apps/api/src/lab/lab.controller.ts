import {
  BadRequestException,
  Controller,
  Get,
  Query,
} from '@nestjs/common';
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
