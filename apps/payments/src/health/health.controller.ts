import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { Public } from '../common/auth.js';
import { isDraining } from '../common/graceful-drain.js';

/**
 * live:  the process is up (checks nothing else).
 * ready: this instance can take traffic: its own database answers. The shop and RabbitMQ are NOT checked: if the
 *        shop is down, payments must still accept Razorpay's webhooks (that's the point of the split).
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    if (isDraining()) throw new ServiceUnavailableException({ status: 'draining' });
    try {
      await this.db.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
    return { status: 'ok' };
  }
}
