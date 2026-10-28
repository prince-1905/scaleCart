import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

export async function createApp(
  env: Env,
  options: { bufferLogs?: boolean; logger?: false } = {},
): Promise<INestApplication> {
  const module = AppModule.forRoot(env);

  // Same application code on either adapter, so they can be compared fairly (Phase 2 experiment).
  return env.httpAdapter === 'fastify'
    ? NestFactory.create(module, new FastifyAdapter(), options)
    : NestFactory.create(module, options);
}
