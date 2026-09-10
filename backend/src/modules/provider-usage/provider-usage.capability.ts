import { providerProfile } from '../llm-providers/provider-profile';
import { LlmProviderType } from '../../entities/llm-provider.entity';

/**
 * Declares which LLM provider types expose a first-party usage/cost API
 * that almyty can ingest (P7). Modelled on the P1 key-URL catalog: a
 * single static map is the source of truth, so the controller, the
 * service dispatcher, and the frontend all agree on capability.
 *
 * IMPORTANT — credential scope: the usage/cost APIs almost always require
 * a DIFFERENT credential than the inference key:
 *   - OpenAI   → an **Admin key** (`sk-admin-...`) with the
 *               `api.usage.read` scope, minted by an org owner. The
 *               normal `sk-...` inference key returns 401 on
 *               `/v1/organization/{usage,costs}`.
 *   - Anthropic → an **Admin API key** (`sk-ant-admin...`) for the
 *               `/v1/organizations/{usage_report,cost_report}` Admin API.
 *               The workspace/inference key cannot read it.
 * That key is stored (encrypted) as `configuration.usageApiKey` on the
 * provider, falling back to the inference key only when it is absent.
 */
export interface ProviderUsageCapability {
  /** True only when a normalized fetcher is implemented for this type. */
  supported: boolean;
  /** The usage API needs a separate admin/org-scoped credential. */
  requiresAdminKey: boolean;
  /** Human label for the UI. */
  label: string;
  /** Docs pointer for operators wiring up the admin key. */
  docsUrl?: string;
  /** Why it is unsupported, when supported === false. */
  note?: string;
}

const CAPABILITY_OVERRIDES: Partial<Record<LlmProviderType, ProviderUsageCapability>> = {
  [LlmProviderType.OPENAI]: {
    supported: true,
    requiresAdminKey: true,
    label: 'OpenAI',
    docsUrl: 'https://platform.openai.com/docs/api-reference/usage',
  },
  [LlmProviderType.ANTHROPIC]: {
    supported: true,
    requiresAdminKey: true,
    label: 'Anthropic',
    docsUrl:
      'https://docs.anthropic.com/en/api/admin-api/usage-cost/get-messages-usage-report',
  },
  // --- Below: no ingestion fetcher implemented. Capability-flagged only;
  //     the service returns supported:false and makes NO network call.
  [LlmProviderType.GOOGLE]: {
    supported: false,
    requiresAdminKey: true,
    label: 'Google (Gemini)',
    note: 'Usage/cost is exposed via Google Cloud Billing / Cloud Monitoring, not a first-party LLM usage endpoint. Not ingested.',
  },
  [LlmProviderType.MISTRAL]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Mistral',
    // Verified against La Plateforme docs (as of 2026-01): usage and
    // billing are exposed only in the console (console.mistral.ai →
    // Usage); there is no public usage/cost API endpoint to ingest.
    note: 'Mistral exposes usage only in the La Plateforme console; there is no public usage/billing API. Not ingested.',
  },
  [LlmProviderType.XAI]: {
    supported: false,
    requiresAdminKey: false,
    label: 'xAI (Grok)',
    note: 'No documented programmatic usage/cost API. Not ingested.',
  },
  [LlmProviderType.DEEPSEEK]: {
    supported: false,
    requiresAdminKey: false,
    label: 'DeepSeek',
    note: 'No documented programmatic usage/cost API. Not ingested.',
  },
  [LlmProviderType.GROQ]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Groq',
    note: 'No documented programmatic usage/cost API. Not ingested.',
  },
  [LlmProviderType.TOGETHER]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Together',
    note: 'No documented programmatic usage/cost API. Not ingested.',
  },
  [LlmProviderType.OPENROUTER]: {
    supported: false,
    requiresAdminKey: false,
    label: 'OpenRouter',
    note: 'Exposes /credits and per-generation cost, not a period usage report. Not ingested.',
  },
  [LlmProviderType.AZURE_OPENAI]: {
    supported: false,
    requiresAdminKey: true,
    label: 'Azure OpenAI',
    note: 'Usage/cost is via Azure Cost Management, not the inference endpoint. Not ingested.',
  },
  [LlmProviderType.AWS_BEDROCK]: {
    supported: false,
    requiresAdminKey: true,
    label: 'AWS Bedrock',
    note: 'Usage/cost is via AWS Cost Explorer / CloudWatch, not the inference endpoint. Not ingested.',
  },
  [LlmProviderType.COHERE]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Cohere',
    note: 'No documented programmatic usage/cost API. Not ingested.',
  },
  [LlmProviderType.HUGGINGFACE]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Hugging Face',
    note: 'No documented programmatic usage/cost API. Not ingested.',
  },
  [LlmProviderType.OLLAMA]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Ollama',
    note: 'Local inference is free — there is no usage/cost API to ingest.',
  },
  [LlmProviderType.FIREWORKS]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Fireworks AI',
    note: 'No documented programmatic usage/cost API. Not ingested.',
  },
  [LlmProviderType.CEREBRAS]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Cerebras',
    note: 'No documented programmatic usage/cost API. Not ingested.',
  },
  [LlmProviderType.DEEPINFRA]: {
    supported: false,
    requiresAdminKey: false,
    label: 'DeepInfra',
    note: 'No documented programmatic usage/cost API. Not ingested.',
  },
  [LlmProviderType.NOVITA]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Novita',
    note: 'No documented programmatic usage/cost API. Not ingested.',
  },
  [LlmProviderType.PERPLEXITY]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Perplexity',
    note: 'No documented programmatic usage/cost API. Not ingested.',
  },
  [LlmProviderType.ZAI]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Z.ai',
    note: 'No documented programmatic usage/cost API. Not ingested.',
  },
  [LlmProviderType.BASETEN]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Baseten',
    note: 'No documented programmatic usage/cost API. Not ingested.',
  },
  [LlmProviderType.NEBIUS]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Nebius Token Factory',
    note: 'No documented programmatic usage/cost API. Not ingested.',
  },
  [LlmProviderType.SAMBANOVA]: {
    supported: false,
    requiresAdminKey: false,
    label: 'SambaNova',
    note: 'No documented programmatic usage/cost API. Not ingested.',
  },
  [LlmProviderType.MOONSHOT]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Moonshot (Kimi)',
    note: 'GET /v1/users/me/balance reports remaining balance only, not per-model usage or cost. Not ingested.',
  },
  [LlmProviderType.QWEN]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Qwen (QwenCloud)',
    note: 'No documented programmatic usage/cost API on compatible-mode. Not ingested.',
  },
  [LlmProviderType.MINIMAX]: {
    supported: false,
    requiresAdminKey: false,
    label: 'MiniMax',
    note: 'No documented programmatic usage or cost API on the OpenAI-compatible surface. Not ingested.',
  },
  [LlmProviderType.UPSTAGE]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Upstage Solar',
    note: 'No usage API. Rate-limit headers (X-Upstage-RateLimit-*) report remaining quota per request, not spend. Not ingested.',
  },
  [LlmProviderType.WRITER]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Writer (Palmyra)',
    note: 'No documented usage or cost API. Not ingested.',
  },
  [LlmProviderType.QIANFAN]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Baidu ERNIE (Qianfan)',
    note: 'No usage API on v2. GET /v2/models embeds per-model pricing, which is a price source rather than a spend source. Not ingested.',
  },
  [LlmProviderType.HUNYUAN]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Tencent Hunyuan (TokenHub)',
    note: 'No documented usage or cost API on the TokenHub gateway. Not ingested.',
  },
  [LlmProviderType.VOLCENGINE]: {
    supported: false,
    requiresAdminKey: false,
    label: 'ByteDance Doubao (Ark)',
    note: 'No documented usage or cost API on the Ark bearer surface. Not ingested.',
  },
  [LlmProviderType.SPARK]: {
    supported: false,
    requiresAdminKey: false,
    label: 'iFlytek Spark',
    note: 'No documented usage or cost API on the HTTP surface. Not ingested.',
  },
  [LlmProviderType.VERTEX_AI]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Google Vertex AI',
    note: 'Usage and cost live in Cloud Billing export, not on the inference API. Not ingested.',
  },
  [LlmProviderType.AZURE_AI_FOUNDRY]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Azure AI Foundry',
    note: 'Usage and cost live in Azure Cost Management, not on the data plane. Not ingested.',
  },
  [LlmProviderType.DIGITALOCEAN]: {
    supported: false,
    requiresAdminKey: false,
    label: 'DigitalOcean Gradient',
    note: 'No documented programmatic usage/cost API for serverless inference. Not ingested.',
  },
  [LlmProviderType.RUNPOD]: {
    supported: false,
    requiresAdminKey: false,
    label: 'RunPod',
    note: 'No documented programmatic usage/cost API for public endpoints. Not ingested.',
  },
  [LlmProviderType.MODAL]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Modal',
    note: 'No documented programmatic usage/cost API for endpoints. Not ingested.',
  },
  [LlmProviderType.CUSTOM]: {
    supported: false,
    requiresAdminKey: false,
    label: 'Custom',
    note: 'Custom endpoints have no standard usage/cost API. Not ingested.',
  },
};

/**
 * One entry per provider type.
 *
 * A vendor with a usage or cost API needs an entry above saying so.
 * Everything else defaults to unsupported, named from its provider
 * profile, which is the honest default: most vendors publish no usage
 * API, and claiming otherwise by omission is worse than saying nothing.
 */
const CAPABILITIES: Record<LlmProviderType, ProviderUsageCapability> = Object.fromEntries(
  Object.values(LlmProviderType).map((type) => {
    const override = CAPABILITY_OVERRIDES[type];
    if (override) return [type, override];
    return [
      type,
      {
        supported: false,
        requiresAdminKey: false,
        label: providerProfile(type)?.displayName ?? type,
        note: 'No documented usage or cost API. Not ingested.',
      } satisfies ProviderUsageCapability,
    ];
  }),
) as Record<LlmProviderType, ProviderUsageCapability>;

export function providerUsageCapability(
  type: LlmProviderType | string,
): ProviderUsageCapability {
  return (
    CAPABILITIES[type as LlmProviderType] ?? {
      supported: false,
      requiresAdminKey: false,
      label: String(type),
      note: 'Unknown provider type. Not ingested.',
    }
  );
}

export function listProviderUsageCapabilities(): Array<
  { type: LlmProviderType } & ProviderUsageCapability
> {
  return (Object.keys(CAPABILITIES) as LlmProviderType[]).map((type) => ({
    type,
    ...CAPABILITIES[type],
  }));
}
