import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProviderUsageSnapshot } from '../../entities/provider-usage-snapshot.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { Conversation } from '../../entities/conversation.entity';

import { ProviderUsageService } from './provider-usage.service';
import { ProviderUsageController } from './provider-usage.controller';

/**
 * External provider usage/cost ingestion (P7). Pulls the provider's own
 * authoritative usage (OpenAI + Anthropic implemented; others
 * capability-flagged), stores it as ProviderUsageSnapshot, and reconciles
 * it against our internal estimate for the Cost tab.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProviderUsageSnapshot,
      LlmProvider,
      Conversation,
    ]),
  ],
  providers: [ProviderUsageService],
  controllers: [ProviderUsageController],
  exports: [ProviderUsageService],
})
export class ProviderUsageModule {}
