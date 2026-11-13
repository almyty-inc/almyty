import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LlmProvider } from '../../entities/llm-provider.entity';
import { Model } from '../../entities/model.entity';
import type { ChatRequest } from './dto/llm-providers.dto';

/**
 * How much a model call may write.
 *
 * A call that names no limit gets the most its model can write, from the
 * model's card (`maxOutputTokens`, kept current by the price feed). An
 * explicit limit wins: the caller's (an agent role's `maxTokens`, a node's
 * setting), then the provider's own setting. An explicit limit above what
 * the card allows is lowered to the card's, which the vendor would refuse.
 *
 * There is no low default behind this. Anthropic needs a number on every
 * call, and its adapter used to send 1024 when it had none, which an
 * autonomous run spent on thinking and then stopped with no answer, marked
 * completed (6 of 10 runs, model comparison 2026-11-13). Chat-completions
 * vendors take no limit as "the model's own", so for them a missing card
 * changes nothing.
 */
export function outputLimitFor(
  request: Pick<ChatRequest, 'maxTokens'>,
  provider: Pick<LlmProvider, 'configuration'>,
  cardMaxOutputTokens: number | null | undefined,
): number | undefined {
  const card = typeof cardMaxOutputTokens === 'number' && cardMaxOutputTokens > 0 ? Math.floor(cardMaxOutputTokens) : undefined;
  const asked = positive(request.maxTokens) ?? positive(provider.configuration?.maxTokens);
  if (asked !== undefined) return card !== undefined ? Math.min(asked, card) : asked;
  return card;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** The stop reasons that mean a reply ran into its output limit, across the wire formats. */
export const OUTPUT_LIMIT_STOP_REASONS: ReadonlySet<string> = new Set([
  'max_tokens', // Anthropic
  'model_context_window_exceeded', // Anthropic, when the context window ends the reply first
  'length', // OpenAI chat completions and the compatible servers
  'MAX_TOKENS', // Gemini
  'max_output_tokens', // OpenAI Responses shape (Perplexity's Agent API)
]);

/** Whether a reply stopped because it reached its output limit. */
export function stoppedAtOutputLimit(finishReason: string | null | undefined): boolean {
  return !!finishReason && OUTPUT_LIMIT_STOP_REASONS.has(finishReason);
}

/** Reads the card and sets the limit on a request; one place for the streaming and non-streaming paths. */
@Injectable()
export class OutputLimitResolver {
  private readonly logger = new Logger(OutputLimitResolver.name);

  constructor(@InjectRepository(Model) private readonly models: Repository<Model>) {}

  async resolve(organizationId: string | undefined, provider: LlmProvider, request: ChatRequest): Promise<ChatRequest> {
    const card = await this.cardLimit(organizationId ?? provider.organizationId, provider, request.model);
    const maxTokens = outputLimitFor(request, provider, card);
    return maxTokens === request.maxTokens || maxTokens === undefined ? request : { ...request, maxTokens };
  }

  private async cardLimit(organizationId: string | undefined, provider: LlmProvider, model: string | undefined): Promise<number | null> {
    if (!organizationId || !model) return null;
    try {
      const card = await this.models.findOne({
        where: { organizationId, providerId: provider.id, vendorModelId: model },
        select: { id: true, maxOutputTokens: true },
      });
      return card?.maxOutputTokens ?? null;
    } catch (err: any) {
      this.logger.warn(`model card lookup failed, no output limit from it: ${err?.message ?? err}`);
      return null;
    }
  }
}
