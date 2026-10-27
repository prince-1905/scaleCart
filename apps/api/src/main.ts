import type { Server } from 'node:http';
import { Logger } from 'nestjs-pino';
import { createApp } from './app.factory.js';
import { loadEnv } from './config/env.js';

async function bootstrap() {
  const env = loadEnv();
  const app = await createApp(env, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  // On SIGTERM: stop accepting connections, finish in-flight requests, then exit.
  app.enableShutdownHooks();

  // Must outlive the load balancer's idle upstream connections. Otherwise Node can
  // close a connection at the moment NGINX reuses it, which surfaces as random 502s.
  const server: Server = app.getHttpServer();
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  await app.listen(env.port, '0.0.0.0');
  app
    .get(Logger)
    .log(`listening on :${env.port} (adapter=${env.httpAdapter}, lab=${env.labEndpoints})`);
}

await bootstrap();
