import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Conversation } from '../../entities/conversation.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';

/**
 * Atomic counter bumps for session and provider rows. Both methods
 * are extracted from LlmChatHelper so the chat path can stay
 * focused on request shape, retries and dispatch.
 */
@Injectable()
export class LlmStatsHelper {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(LlmProvider)
    private readonly llmProviderRepository: Repository<LlmProvider>,
  ) {}

  async bumpSessionStats(
    sessionId: string,
    delta: {
      inputTokens: number;
      outputTokens: number;
      cost: number;
      toolCall: boolean;
      toolCallSuccess: boolean;
    },
  ): Promise<void> {
    const input = Number(delta.inputTokens) || 0;
    const output = Number(delta.outputTokens) || 0;
    const cost = Number(delta.cost) || 0;
    await this.conversationRepository
      .createQueryBuilder()
      .update(Conversation)
      .set({
        messageCount: () => '"messageCount" + 1',
        totalInputTokens: () => `"totalInputTokens" + ${input}`,
        totalOutputTokens: () => `"totalOutputTokens" + ${output}`,
        totalCost: () => `"totalCost" + ${cost}`,
        toolCalls: delta.toolCall
          ? () => '"toolCalls" + 1'
          : () => '"toolCalls"',
        successfulToolCalls: delta.toolCall && delta.toolCallSuccess
          ? () => '"successfulToolCalls" + 1'
          : () => '"successfulToolCalls"',
        lastActivityAt: new Date(),
      })
      .where('id = :id', { id: sessionId })
      .execute();
  }
  /**
   * Atomic provider counter bump. Same pattern as session — a
   * single UPDATE with column expressions so concurrent chat calls
   * don't lose increments.
   */
  async bumpProviderStats(
    providerId: string,
    delta: { tokens: number; cost: number; success: boolean },
  ): Promise<void> {
    const tokens = Number(delta.tokens) || 0;
    const cost = Number(delta.cost) || 0;
    await this.llmProviderRepository
      .createQueryBuilder()
      .update(LlmProvider)
      .set({
        totalRequests: () => '"totalRequests" + 1',
        successfulRequests: delta.success
          ? () => '"successfulRequests" + 1'
          : () => '"successfulRequests"',
        totalTokensUsed: () => `"totalTokensUsed" + ${tokens}`,
        totalCost: () => `"totalCost" + ${cost}`,
        lastRequestAt: new Date(),
      })
      .where('id = :id', { id: providerId })
      .execute();
  }
}
