import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Server } from 'node:http';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { drainOnSignals } from './common/graceful-drain.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
// rawBody: Razorpay signs the webhook's exact bytes (req.rawBody), not the parsed JSON.
const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(env), new FastifyAdapter(), {
  bufferLogs: true,
  rawBody: true,
});
app.useLogger(app.get(Logger));

const server: Server = app.getHttpServer();
// Longer than NGINX's idle upstream connections, or Node may close one just as NGINX reuses it (random 502s).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
drainOnSignals(server, env.shutdownDrainSeconds * 1000, () => app.close(), (msg) => app.get(Logger).log(msg));

await app.listen({ port: env.port, host: '0.0.0.0' });
app.get(Logger).log(`payments service listening on :${env.port} (shop at ${env.shopUrl})`);
