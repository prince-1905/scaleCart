import { Controller, Get, Header } from '@nestjs/common';
import { Registry } from 'prom-client';
import { Public } from '../common/auth.js';
import { MetricsService } from './metrics.service.js';

// Public for the local lab. In production, serve it on an internal-only port instead.
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /** Scraped by Prometheus every few seconds. */
  @Get()
  @Header('Content-Type', Registry.PROMETHEUS_CONTENT_TYPE)
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
