import { Controller, Get } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Public } from '../common/auth.js';
import { API_DATABASES } from '../database/modules.js';

/**
 * Two separate probes, on purpose:
 * - live:  "is this process alive?" Checks nothing external, so a database blip
 *          can never make Kubernetes restart every pod at once.
 * - ready: "should this instance receive traffic?" Pings every module's database
 *          (Redis joins in Phase 2). Failing it only takes this instance out of the
 *          load balancer until the dependency is back.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check(
      API_DATABASES.map((module) => () => {
        const connection = this.moduleRef.get(getDataSourceToken(module), { strict: false });
        return this.db.pingCheck(`db_${module}`, { connection, timeout: 1_000 });
      }),
    );
  }
}
