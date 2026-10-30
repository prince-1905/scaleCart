import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { loadEnv } from './config/env.js';
import { WorkerModule } from './worker/worker.module.js';

// Entry point of the background worker: `node dist/worker.js`
const env = loadEnv(process.env, 'worker');
const app = await NestFactory.create(WorkerModule.forRoot(env), new FastifyAdapter(), {
  bufferLogs: true,
});
app.useLogger(app.get(Logger));
// On SIGTERM: stop the relay loop, close the RabbitMQ connection, then exit.
app.enableShutdownHooks();
await app.listen(env.port, '0.0.0.0');
app.get(Logger).log(`worker listening on :${env.port} (metrics + health)`);
