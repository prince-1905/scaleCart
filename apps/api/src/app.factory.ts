import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

export async function createApp(
  env: Env,
  options: { bufferLogs?: boolean; logger?: false } = {},
): Promise<INestApplication> {
  const module = AppModule.forRoot(env);

  // Same application code on either adapter, so they can be compared fairly (Phase 2 experiment).
  const app =
    env.httpAdapter === 'fastify'
      ? await NestFactory.create(module, new FastifyAdapter(), options)
      : await NestFactory.create(module, options);

  if (env.apiDocs) {
    const config = new DocumentBuilder()
      .setTitle('ScaleCart API')
      .setDescription(
        'Shop backend for flash sales. Log in with POST /auth/login, then click "Authorize" and paste the accessToken.',
      )
      .addBearerAuth()
      .addSecurityRequirements('bearer')
      .build();
    SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, config));
  }
  return app;
}

/**
 * Starts listening with an explicit accept-queue size (backlog). Each adapter takes it
 * differently: Fastify in its options object, Node's http.Server as a third argument.
 */
export async function listen(app: INestApplication, env: Env, host = '0.0.0.0'): Promise<void> {
  // Nest forwards these arguments to the adapter as-is; its typings just don't list them.
  const server = app as unknown as { listen(...args: unknown[]): Promise<unknown> };
  if (env.httpAdapter === 'fastify') {
    await server.listen({ port: env.port, host, backlog: env.listenBacklog });
  } else {
    await server.listen(env.port, host, env.listenBacklog);
  }
}
