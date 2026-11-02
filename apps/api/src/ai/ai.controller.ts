import {
  BadRequestException,
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import { PassThrough } from 'node:stream';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.js';
import { ChatDto } from './chat.dto.js';
import { ChatThrottle } from './chat-throttle.js';
import { LlmError, type LlmErrorKind } from './llm-client.js';
import { ProductCopyDto } from './product-copy.dto.js';
import { ProductCopywriter } from './product-copywriter.js';
import { ShoppingAssistant } from './shopping-assistant.js';

/** What the shopper sees when the AI provider fails. Details stay in our log. */
const LLM_ERRORS: Record<LlmErrorKind, [HttpStatus, string]> = {
  rate_limited: [HttpStatus.TOO_MANY_REQUESTS, 'the assistant is busy right now; try again in a minute'],
  timeout: [HttpStatus.GATEWAY_TIMEOUT, 'the assistant took too long to answer; try again'],
  unavailable: [HttpStatus.BAD_GATEWAY, 'the assistant is unavailable right now; try again later'],
  bad_request: [HttpStatus.BAD_GATEWAY, 'the assistant could not handle that message'],
  blocked: [HttpStatus.UNPROCESSABLE_ENTITY, 'that message was blocked by the safety filter'],
  invalid_output: [HttpStatus.BAD_GATEWAY, 'the AI returned unusable output twice; try again'],
};

@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(
    private readonly assistant: ShoppingAssistant,
    private readonly copywriter: ProductCopywriter,
    private readonly throttle: ChatThrottle,
  ) {}

  /** One assistant reply, as a single JSON answer. Signed-in users only: the tools act on *your* cart and orders. */
  @Post('chat')
  @HttpCode(200)
  async chat(@CurrentUser() user: AuthUser, @Body() dto: ChatDto) {
    await this.assertCanChat(user, dto);
    try {
      return await this.assistant.chat(dto.messages, { userId: user.id });
    } catch (err) {
      const { status, error, message } = this.describe(err);
      throw new HttpException({ statusCode: status, error, message }, status);
    }
  }

  /**
   * The same reply, streamed as NDJSON (one JSON object per line) so the chat widget can show
   * progress while tools run:
   *
   *   {"type":"tool_start","name":"search_products"}
   *   {"type":"tool_end","name":"search_products","ok":true,"durationMs":113}
   *   {"type":"reply","reply":"…","products":[…],"toolCalls":[…],"stats":{…}}   or   {"type":"error",…}
   *
   * Checks (login, limits, input) still fail with normal HTTP errors, before streaming starts.
   */
  @Post('chat/stream')
  @HttpCode(200)
  @Header('Cache-Control', 'no-cache')
  async chatStream(@CurrentUser() user: AuthUser, @Body() dto: ChatDto): Promise<StreamableFile> {
    await this.assertCanChat(user, dto);

    const out = new PassThrough();
    const cancel = new AbortController();
    out.on('close', () => cancel.abort());
    const send = (event: object) => {
      if (!out.destroyed) out.write(`${JSON.stringify(event)}\n`);
    };

    // Not awaited: the response starts now and the loop writes into it as it goes.
    void this.assistant
      .chat(dto.messages, { userId: user.id }, send, cancel.signal)
      .then((result) => send({ type: 'reply', ...result }))
      .catch((err: unknown) => send({ type: 'error', ...this.describe(err) }))
      .finally(() => out.end());

    return new StreamableFile(out, { type: 'application/x-ndjson; charset=utf-8' });
  }

  /**
   * Admin only: drafts product copy (title, descriptions, bullets, SEO fields, tags) as validated
   * JSON. Nothing is saved: the admin reviews and edits it, then saves with PATCH /products/:id.
   */
  @Roles('admin')
  @Post('product-copy')
  @HttpCode(200)
  async productCopy(@CurrentUser() user: AuthUser, @Body() dto: ProductCopyDto) {
    this.assertEnabled();
    await this.throttle.assertAllowed(user.id);
    try {
      return await this.copywriter.write(dto);
    } catch (err) {
      const { status, error, message } = this.describe(err);
      throw new HttpException({ statusCode: status, error, message }, status);
    }
  }

  private assertEnabled(): void {
    if (!this.assistant.enabled) {
      throw new ServiceUnavailableException('the AI assistant is not configured (GEMINI_API_KEY)');
    }
  }

  private async assertCanChat(user: AuthUser, dto: ChatDto): Promise<void> {
    this.assertEnabled();
    if (dto.messages.at(-1)!.role !== 'user') {
      throw new BadRequestException('the last message must be from the user');
    }
    await this.throttle.assertAllowed(user.id);
  }

  /** Provider errors → a status and a safe message. Anything else is our bug: log it, say little. */
  private describe(err: unknown): { status: HttpStatus; error: string; message: string } {
    if (err instanceof LlmError) {
      this.logger.warn(`AI provider error (${err.kind}): ${err.message}`);
      const [status, message] = LLM_ERRORS[err.kind];
      return { status, error: `ai_${err.kind}`, message };
    }
    this.logger.error(`chat failed: ${(err as Error).stack ?? String(err)}`);
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, error: 'internal', message: 'something went wrong; try again' };
  }
}
