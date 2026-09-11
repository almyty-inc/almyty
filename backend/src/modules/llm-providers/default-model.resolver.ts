import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { LlmProvider, LlmProviderType } from '../../entities/llm-provider.entity';
import { LlmModelsHelper } from './llm-models.helper';

/**
 * Picks the model to use when neither the request nor the provider
 * configuration names one.
 *
 * There are deliberately NO model ids in this file. Vendors retire ids on
 * their own schedule, and a literal typed in here is a retired id with a
 * countdown on it (claude-sonnet-4-20250514 took the staging scheduler
 * down for a morning). Instead we ask the vendor what it serves right now
 * and choose by family preference, so the default tracks the vendor.
 *
 * If the vendor cannot tell us, we fail loudly and say what to set,
 * rather than guessing.
 */
export class NoModelAvailableError extends BadRequestException {
  readonly code = 'NO_MODEL_CONFIGURED';

  constructor(provider: Pick<LlmProvider, 'id' | 'name' | 'type'>, detail: string) {
    super({
      code: 'NO_MODEL_CONFIGURED',
      message:
        `No model is configured for provider "${provider.name ?? provider.id}" (${provider.type}) and ${detail}. ` +
        'Set a model on the provider, or on the agent node that uses it.',
    });
  }
}

/** Family order shared by hosts that serve other vendors' open models. */
const OPEN_MODEL_HOST_PREFERENCE: RegExp[] = [
  /llama.*instruct/i,
  /qwen.*instruct/i,
  /deepseek-v\d/i,
  /llama/i,
  /qwen/i,
  /deepseek/i,
];

/** Hosts whose default falls back to the first served model when no preferred family is listed. */
const OPEN_MODEL_HOSTS: ReadonlySet<LlmProviderType> = new Set([
  LlmProviderType.FIREWORKS,
  LlmProviderType.CEREBRAS,
  LlmProviderType.DEEPINFRA,
  LlmProviderType.NOVITA,
  LlmProviderType.BASETEN,
  LlmProviderType.NEBIUS,
  LlmProviderType.SAMBANOVA,
  LlmProviderType.DIGITALOCEAN,
  LlmProviderType.RUNPOD,
  LlmProviderType.MODAL,
]);

/** Ordered family preferences per provider type; first regex with a match wins. */
const FAMILY_PREFERENCE: Partial<Record<LlmProviderType, RegExp[]>> = {
  [LlmProviderType.ANTHROPIC]: [/^claude-sonnet-\d/, /^claude-opus-\d/, /^claude-haiku-\d/, /^claude-/],
  [LlmProviderType.OPENAI]: [/^gpt-\d+(\.\d+)?$/, /^gpt-\d+(\.\d+)?-mini$/, /^gpt-\d/, /^o\d/],
  [LlmProviderType.AZURE_OPENAI]: [/^gpt-\d+(\.\d+)?$/, /^gpt-\d/],
  [LlmProviderType.GOOGLE]: [/^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-pro$/, /^gemini-[\d.]+-flash/, /^gemini-/],
  [LlmProviderType.MISTRAL]: [/^mistral-large-latest$/, /^mistral-medium-latest$/, /^mistral-small-latest$/, /^mistral-large/, /^mistral-/],
  [LlmProviderType.XAI]: [/^grok-\d+$/, /^grok-\d/, /^grok-/],
  [LlmProviderType.DEEPSEEK]: [/^deepseek-chat$/, /^deepseek-/],
  [LlmProviderType.GROQ]: [/llama-[\d.]+-70b-versatile$/, /llama-[\d.]+-\d+b/, /llama/i],
  [LlmProviderType.TOGETHER]: [/llama-[\d.]+-70b-instruct-turbo$/i, /llama.*instruct/i, /llama/i],
  [LlmProviderType.OPENROUTER]: [/^anthropic\/claude-sonnet-\d/, /^openai\/gpt-\d+(\.\d+)?$/, /^anthropic\/claude-/, /^openai\/gpt-/],
  [LlmProviderType.COHERE]: [/^command-a/, /^command-r-plus/, /^command-r/, /^command/],
  // The Agent API lists ids as "creator/model" (perplexity/sonar,
  // openai/gpt-5.6-sol, anthropic/claude-opus-5, ...). Perplexity's own
  // web-grounded Sonar is the sensible default for a Perplexity provider;
  // the bare `sonar` forms are the retiring legacy Sonar ids, kept so a
  // provider still pointed at that surface resolves.
  [LlmProviderType.PERPLEXITY]: [/^perplexity\/sonar$/, /^perplexity\//, /^sonar-pro$/, /^sonar$/, /^sonar/],
  [LlmProviderType.ZAI]: [/^glm-[\d.]+$/, /^glm-[\d.]+-flash$/, /^glm-/],
  // Hosted open-model vendors list many authors' models under the
  // authors' own ids (often "org/model"); prefer instruct Llama, then
  // Qwen, then DeepSeek, then anything in those families.
  [LlmProviderType.FIREWORKS]: OPEN_MODEL_HOST_PREFERENCE,
  [LlmProviderType.CEREBRAS]: OPEN_MODEL_HOST_PREFERENCE,
  [LlmProviderType.DEEPINFRA]: OPEN_MODEL_HOST_PREFERENCE,
  [LlmProviderType.NOVITA]: OPEN_MODEL_HOST_PREFERENCE,
  [LlmProviderType.BASETEN]: OPEN_MODEL_HOST_PREFERENCE,
  [LlmProviderType.NEBIUS]: OPEN_MODEL_HOST_PREFERENCE,
  [LlmProviderType.SAMBANOVA]: OPEN_MODEL_HOST_PREFERENCE,
  [LlmProviderType.DIGITALOCEAN]: OPEN_MODEL_HOST_PREFERENCE,
  [LlmProviderType.RUNPOD]: OPEN_MODEL_HOST_PREFERENCE,
  [LlmProviderType.MODAL]: OPEN_MODEL_HOST_PREFERENCE,
  // Moonshot serves only Kimi; prefer the plain flagship id over the
  // coding and high-speed variants. No literal ids: the vendor's own list
  // decides which K generation is current.
  [LlmProviderType.MOONSHOT]: [/^kimi-k[\d.]+$/, /^kimi-k/, /^kimi-/],
  // Qwen's tiers are max > plus > flash. Undated aliases win over dated
  // snapshots via the shared NOT_A_DEFAULT filter.
  [LlmProviderType.QWEN]: [/^qwen[\d.]*-max$/, /^qwen[\d.]*-plus$/, /^qwen[\d.]*-flash$/, /^qwen[\d.]*-max/, /^qwen/],
  // Bedrock and Foundry list ids we cannot rank meaningfully (inference
  // profile ids and the customer's own deployment names), so neither gets
  // a preference: pickPreferredModel falls through to the first served
  // chat model, and a user who wants a specific one sets it.
};

/**
 * Ids that are chat-capable but not what anyone means by "the default":
 * embeddings, audio, image, moderation, realtime, and dated snapshots
 * (the alias without the date tracks the vendor's current build).
 */
const NOT_A_DEFAULT = /(embed|embedding|whisper|tts|audio|realtime|image|dall-e|moderation|transcri|search|vision-only|preview|-\d{8}$|-\d{4}-\d{2}-\d{2}$|latest-\d)/i;

const CACHE_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class DefaultModelResolver {
  private readonly logger = new Logger(DefaultModelResolver.name);
  private readonly cache = new Map<string, { model: string; expiresAt: number }>();

  constructor(private readonly modelsHelper: LlmModelsHelper) {}

  /**
   * The model to send for this provider: the configured one, else the
   * vendor's current preferred model (cached per provider for an hour).
   */
  async resolve(provider: LlmProvider): Promise<string> {
    const configured = provider.configuration?.model?.trim();
    if (configured) return configured;

    // Azure OpenAI names a DEPLOYMENT in the `model` field, not a catalog
    // model id, and `GET /openai/v1/models` lists the catalog rather than
    // the resource's deployments. Picking from that list would name
    // something the resource has not deployed, so the configured
    // deployment name is the default instead.
    if (provider.type === LlmProviderType.AZURE_OPENAI) {
      const deployment = provider.configuration?.azure?.deploymentName?.trim();
      if (deployment) return deployment;
    }

    const key = provider.id ?? `${provider.type}:${provider.getApiUrl?.() ?? ''}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.model;

    // A listing failure (no /models on this base, network, auth) is the
    // same "nothing to choose from" as an empty list: report it under
    // NO_MODEL_CONFIGURED with the vendor's reason, never guess an id.
    let models: Awaited<ReturnType<LlmModelsHelper['fetchModelsFromProvider']>>;
    try {
      models = await this.modelsHelper.fetchModelsFromProvider(provider);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new NoModelAvailableError(provider, `the vendor could not list its models (${reason})`);
    }
    const ids = models.map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) {
      throw new NoModelAvailableError(provider, 'the vendor returned no models to choose from');
    }
    const picked = pickPreferredModel(provider.type, ids);
    if (!picked) {
      throw new NoModelAvailableError(provider, `none of the ${ids.length} models the vendor lists is a chat model we recognise`);
    }
    this.cache.set(key, { model: picked, expiresAt: Date.now() + CACHE_TTL_MS });
    this.logger.log(`Resolved default model for provider ${provider.id ?? provider.type}: ${picked}`);
    return picked;
  }

  /** Drop the cached choice, e.g. after the vendor said the model is gone. */
  invalidate(providerId: string): void {
    this.cache.delete(providerId);
  }
}

/**
 * Choose the best id from what the vendor lists, without knowing any id
 * in advance. Family preference first (Sonnet over Opus over Haiku for
 * Anthropic, plain gpt-N over mini for OpenAI, ...), then the highest
 * version number within that family, preferring undated aliases.
 */
export function pickPreferredModel(type: LlmProviderType, ids: string[]): string | undefined {
  const candidates = ids.filter((id) => !NOT_A_DEFAULT.test(id));
  const pool = candidates.length > 0 ? candidates : ids;
  const prefs = FAMILY_PREFERENCE[type];
  if (prefs) {
    for (const re of prefs) {
      const matches = pool.filter((id) => re.test(id));
      if (matches.length > 0) return newest(matches);
    }
    // Hosts serve a moving catalog of other vendors' open models; when no
    // preferred family is listed, the first chat model served is still a
    // sound default. First-party vendors fail instead (see resolve()).
    return OPEN_MODEL_HOSTS.has(type) ? pool[0] : undefined;
  }
  // Ollama / HuggingFace / custom: whatever the endpoint serves first.
  return pool[0];
}

/** Highest numeric version tuple wins; ties go to the shorter (alias) id. */
function newest(ids: string[]): string {
  return [...ids].sort((a, b) => {
    const va = versionTuple(a);
    const vb = versionTuple(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const d = (vb[i] ?? 0) - (va[i] ?? 0);
      if (d !== 0) return d;
    }
    return a.length - b.length;
  })[0];
}

function versionTuple(id: string): number[] {
  return (id.match(/\d+(\.\d+)*/g) ?? []).flatMap((n) => n.split('.').map(Number)).slice(0, 4);
}
