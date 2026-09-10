import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../entities/llm-provider.entity';
import { LlmProviderSecretsHelper } from './llm-provider-secrets.helper';

/** Where a model card's endpoint provider row says it came from. */
export const ENDPOINT_MANAGED_KIND = 'model_endpoint';

export interface EndpointProviderInput {
  organizationId: string;
  /** An existing row to update (the card's providerId). */
  providerId?: string | null;
  name: string;
  /** OpenAI-compatible base; chat goes to `<apiUrl>/chat/completions`. */
  apiUrl: string;
  model: string;
  /** A pasted key: it lands in a managed credential row, never inline. */
  apiKey?: string;
  /** An existing connection to use instead. */
  credentialId?: string | null;
  /** The card or deployment this row belongs to. */
  managedById: string;
  region?: string | null;
}

/**
 * A model card that is served by an endpoint we run (a deployment) or by
 * one an admin registered still needs a real provider row: conversations
 * carry a provider foreign key, stats are written per provider id, and
 * secrets belong in the credential store like every other provider's.
 *
 * The row is an `openai` provider, because that is what an
 * OpenAI-compatible server speaks: chat at `<base>/chat/completions`,
 * bearer auth, streaming. Nothing here invents a transient provider.
 */
@Injectable()
export class EndpointProviderHelper {
  private readonly logger = new Logger(EndpointProviderHelper.name);

  constructor(
    @InjectRepository(LlmProvider) private readonly providers: Repository<LlmProvider>,
    private readonly secrets: LlmProviderSecretsHelper,
  ) {}

  /**
   * The OpenAI-compatible base for a URL an adapter reported. Adapters
   * that know it say so (`ActualState.openAiBase`); otherwise a URL that
   * already carries a version segment is the base, and one that does not
   * gets `/v1` appended, which is where every vLLM, TGI, Ollama and
   * LiteLLM server puts its OpenAI surface.
   */
  static baseFor(url: string, declared?: string | null): string {
    const chosen = (declared ?? url ?? '').trim().replace(/\/+$/, '');
    if (!chosen) return '';
    if (/\/(v\d+[a-z]*|openai|inference)(\/|$)/i.test(chosen)) return chosen;
    return `${chosen}/v1`;
  }

  async upsert(input: EndpointProviderInput): Promise<LlmProvider> {
    const apiUrl = EndpointProviderHelper.baseFor(input.apiUrl);
    let provider = input.providerId
      ? await this.providers.findOne({ where: { id: input.providerId, organizationId: input.organizationId } })
      : null;
    const managedBy = { kind: ENDPOINT_MANAGED_KIND, id: input.managedById };

    if (provider && (provider.metadata as Record<string, any> | null)?.managedBy?.id !== input.managedById) {
      // The card points at a provider someone else owns: leave it alone.
      return provider;
    }

    if (!provider) {
      provider = this.providers.create({
        organizationId: input.organizationId,
        name: input.name,
        description: 'Created for a model served by an endpoint',
        type: LlmProviderType.OPENAI,
        capabilities: {},
      } as Partial<LlmProvider>) as LlmProvider;
    }

    provider.name = input.name;
    provider.type = LlmProviderType.OPENAI;
    provider.status = LlmProviderStatus.ACTIVE;
    provider.isHealthy = true;
    provider.configuration = { ...(provider.configuration ?? {}), apiUrl, model: input.model };
    provider.metadata = { ...(provider.metadata ?? {}), managedBy, endpointRegion: input.region ?? null } as LlmProvider['metadata'];
    const saved = await this.providers.save(provider);

    if (input.credentialId !== undefined || input.apiKey) {
      await this.secrets.applyKey(saved, 'inference', { plaintext: input.apiKey, credentialId: input.credentialId });
      await this.providers.save(saved);
    }
    return saved;
  }

  /** The endpoint is gone or stopped: the row must stop answering. */
  async deactivate(organizationId: string, providerId: string | null | undefined, managedById: string): Promise<void> {
    if (!providerId) return;
    const provider = await this.providers.findOne({ where: { id: providerId, organizationId } });
    if (!provider) return;
    if ((provider.metadata as Record<string, any> | null)?.managedBy?.id !== managedById) return;
    if (provider.status === LlmProviderStatus.INACTIVE && !provider.isHealthy) return;
    provider.status = LlmProviderStatus.INACTIVE;
    provider.isHealthy = false;
    await this.providers.save(provider);
    this.logger.log(`endpoint provider ${provider.id} deactivated: its endpoint is no longer serving`);
  }
}
