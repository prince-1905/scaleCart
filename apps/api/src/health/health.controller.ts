import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

/**
 * Two separate probes, on purpose:
 * - live:  "is this process alive?" Checks nothing external, so a database blip
 *          can never make Kubernetes restart every pod at once.
 * - ready: "should this instance receive traffic?" Dependency checks (DB, Redis)
 *          get added here in later phases.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthCheckService) {}

  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([]);
  }
}
