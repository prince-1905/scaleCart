import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Server } from 'node:http';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { drainOnSignals } from './common/graceful-drain.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
// trustProxy: behind NGINX → Kong, the client's address comes in X-Real-IP (per-IP login limits use it).
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule.forRoot(env),
  new FastifyAdapter({ trustProxy: env.trustProxy }),
  { bufferLogs: true },
);
app.useLogger(app.get(Logger));

const server: Server = app.getHttpServer();
// Longer than the proxy's idle upstream connections, or Node may close one just as the proxy reuses it (random 502s).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
drainOnSignals(server, env.shutdownDrainSeconds * 1000, () => app.close(), (msg) => app.get(Logger).log(msg));

await app.listen({ port: env.port, host: '0.0.0.0' });
app.get(Logger).log(`identity service listening on :${env.port} (signing key ${env.signingKey.kid})`);
