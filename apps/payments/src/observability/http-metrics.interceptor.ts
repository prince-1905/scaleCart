import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { Observable } from 'rxjs';
import { MetricsService } from './metrics.service.js';

const INSTANCE = hostname();
const UNMEASURED = new Set(['/metrics', '/health/live', '/health/ready']);

/** Route template (e.g. `/products/:id`) for both Fastify and Express requests. */
function routeOf(req: any): string {
  const fastifyRoute: string | undefined = req.routeOptions?.url;
  if (fastifyRoute) return fastifyRoute;
  if (req.route?.path) return `${req.baseUrl ?? ''}${req.route.path}`;
  return 'unmatched';
}

/**
 * Records request duration and in-flight count, and tags every response with
 * `X-Instance` so load tests can prove traffic is spread across replicas.
 *
 * Timing ends on the raw Node response's `close` event, so the status code is
 * the one actually sent, including responses produced by exception filters.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(
    private readonly metrics: MetricsService,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    const route = routeOf(req);

    this.adapterHost.httpAdapter.setHeader(res, 'x-instance', INSTANCE);
    if (UNMEASURED.has(route)) return next.handle();

    const raw: ServerResponse = res.raw ?? res;
    const stopTimer = this.metrics.httpDuration.startTimer({
      method: req.method,
      route,
    });
    this.metrics.httpInFlight.inc();

    raw.once('close', () => {
      this.metrics.httpInFlight.dec();
      stopTimer({
        status_code: raw.writableFinished ? String(raw.statusCode) : 'aborted',
      });
    });

    return next.handle();
  }
}
