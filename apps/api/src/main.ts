import type { Server } from 'node:http';
import { Logger } from 'nestjs-pino';
import { createApp, listen } from './app.factory.js';
import { drainOnSignals } from './common/graceful-drain.js';
import { loadEnv } from './config/env.js';

async function bootstrap() {
  const env = loadEnv();
  const app = await createApp(env, { bufferLogs: true });

  app.useLogger(app.get(Logger));

  // Must outlive the load balancer's idle upstream connections. Otherwise Node can
  // close a connection at the moment NGINX reuses it, which surfaces as random 502s.
  const server: Server = app.getHttpServer();
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  // After this many requests on one connection, answer with Connection: close, so the client
  // reconnects. Kubernetes' Service balances connections, not requests: without this, clients
  // that opened their connections before a scale-out keep them on the old pods (E7b). 0 = no limit.
  server.maxRequestsPerSocket = env.httpMaxRequestsPerSocket;

  // On SIGTERM: keep serving for a few seconds while telling clients to reconnect elsewhere
  // (Connection: close), then stop accepting, finish in-flight requests, run shutdown hooks, exit.
  drainOnSignals(server, env.shutdownDrainSeconds * 1000, () => app.close(), (msg) => app.get(Logger).log(msg));

  await listen(app, env);
  app
    .get(Logger)
    .log(
      `listening on :${env.port} (adapter=${env.httpAdapter}, backlog=${env.listenBacklog}, ` +
        `cache=${env.cacheEnabled}, lab=${env.labEndpoints})`,
    );
}

await bootstrap();
