import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module.js';
import { CartModule } from '../cart/cart.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { ENV, type Env } from '../config/env.js';
import { InventoryCoreModule } from '../inventory/inventory-core.module.js';
import { OrdersCoreModule } from '../orders/orders-core.module.js';
import { AiController } from './ai.controller.js';
import { ChatThrottle } from './chat-throttle.js';
import { GeminiClient, type LlmClient } from './llm-client.js';
import { ProductCopywriter } from './product-copywriter.js';
import { ShopTools } from './shop-tools.js';
import { McpController } from './mcp.controller.js';
import { LLM_CLIENT, ShoppingAssistant } from './shopping-assistant.js';

/**
 * The AI features: shopping assistant, product copy, and the MCP server.
 * Talks to the other modules only through their exported services.
 */
@Module({
  imports: [CatalogModule, InventoryCoreModule, CartModule, OrdersCoreModule, CacheModule],
  controllers: [AiController, McpController],
  providers: [
    {
      provide: LLM_CLIENT,
      inject: [ENV],
      useFactory: (env: Env): LlmClient | null =>
        env.geminiApiKey
          ? new GeminiClient({
              apiKey: env.geminiApiKey,
              model: env.aiModel,
              timeoutMs: env.aiTimeoutMs,
              thinkingLevel: env.aiThinkingLevel,
            })
          : null,
    },
    ShopTools,
    ShoppingAssistant,
    ProductCopywriter,
    ChatThrottle,
  ],
})
export class AiModule {}
