import { LlmProviderType } from '../../entities/llm-provider.entity';

/**
 * A vendor as data.
 *
 * Adding an inference vendor used to mean editing eight files across two
 * languages: an enum member, a base URL case, an auth case, two dispatch
 * lists, a model-list case, a price-feed row, a usage-capability row and
 * five catalog maps. The result was predictable. The list grew by whoever
 * was cheapest to wire rather than by who mattered, three enum-derived
 * guards had to be invented to catch the half-finished ones, and the
 * question of which vendors we carry kept being reopened.
 *
 * Almost none of that is code. A vendor is a base URL, an auth header, a
 * path, a listing shape and a pricing source. That is a row.
 *
 * `provider-profile.spec.ts` proves every profile reproduces exactly what
 * the entity's switches produce today, so the switches can be replaced by
 * a lookup with evidence rather than hope.
 *
 * See docs/design/layers.md, L2.
 */

/**
 * The wire protocols we implement.
 *
 * There is no single generic path with exceptions. There are several real
 * protocols, each spoken by many vendors, and each is ONE implementation
 * that many vendors share: implement it once and every vendor speaking it
 * becomes a row.
 *
 * The registry is closed in the sense that adding an entry is a
 * deliberate code change with an implementation, a test and documentation.
 * It is not a frozen list: vendor natives keep appearing, and several
 * expose capabilities their OpenAI-compatible mode hides, which is why
 * they earn a protocol rather than a quirk field.
 */
export type Protocol =
  | 'chat_completions'
  | 'responses'
  | 'anthropic_messages'
  | 'gemini_generate_content'
  | 'bedrock_converse'
  | 'cohere_v2'
  | 'dashscope_native'
  | 'embeddings'
  | 'rerank';

/**
 * How the key reaches the vendor. Orthogonal to protocol: Vertex minting a
 * one-hour token per call is auth, not a different wire shape.
 */
export type ProviderAuth =
  /** `Authorization: Bearer <key>`, the overwhelming majority. */
  | { scheme: 'bearer'; extraHeaders?: Record<string, string> }
  /** A named header carrying the raw key, e.g. Azure's `api-key`. */
  | { scheme: 'header'; header: string; extraHeaders?: Record<string, string> }
  /** The vendor supplies its own headers elsewhere; emit none here. */
  | { scheme: 'none' };

/** One protocol a vendor speaks, and everything needed to speak it. */
export interface ProtocolBinding {
  protocol: Protocol;
  /** Exactly one binding per profile is preferred. Native beats compat. */
  preferred?: boolean;
  /**
   * The base. When the vendor serves several, `bases` maps the value of
   * `basesField` to one and `baseUrl` is the default. `{dotted.path}`
   * placeholders are filled from the configuration, with `||` giving a
   * default, which is how a base embedding an account's own region,
   * resource or endpoint id stays data.
   */
  baseUrl: string;
  bases?: Record<string, string>;
  basesField?: string;
  auth: ProviderAuth;
  /** Appended to the base for a call on this protocol. */
  path: string;
  /**
   * Appended to the base to list models, or null when the vendor
   * documents none. Null is a normal answer: the user names the model and
   * a miss surfaces as NO_MODEL_CONFIGURED.
   */
  listingPath: string | null;
}

export interface ProviderProfile {
  key: LlmProviderType;
  displayName: string;
  /** One line on what this vendor serves, for the picker. */
  blurb: string;
  /** Protocols this vendor speaks. Most speak exactly one today. */
  protocols: ProtocolBinding[];
  /** Where live prices come from, or null when absent from the feed. */
  pricing: { litellm: string[]; openrouterPrefix: string | null } | null;
  capabilities: string[];
  keyUrl: string;
  docsUrl: string;
  /** The date this vendor's surface was last checked against its docs. */
  verified: string;
}

const BEARER: ProviderAuth = { scheme: 'bearer' };

/**
 * The built-in vendors. Ordered as the create form offers them.
 */
export const PROVIDER_PROFILES: ProviderProfile[] = [
  {
    key: LlmProviderType.XAI,
    displayName: 'xAI (Grok)',
    blurb: 'Grok 4 and the Grok code models',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://api.x.ai/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['xai'], openrouterPrefix: 'x-ai/' },
    capabilities: ['Tool Use', 'Streaming', 'Vision'],
    keyUrl: 'https://console.x.ai',
    docsUrl: 'https://docs.x.ai/api',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.DEEPSEEK,
    displayName: 'DeepSeek',
    blurb: 'DeepSeek V4 and the reasoning line',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        // Documented with no /v1 segment: chat at <base>/chat/completions.
        baseUrl: 'https://api.deepseek.com',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['deepseek'], openrouterPrefix: 'deepseek/' },
    capabilities: ['Tool Use', 'Streaming'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.MOONSHOT,
    displayName: 'Moonshot (Kimi)',
    blurb: 'Kimi K3 and the K2.7 coding models',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        // api.moonshot.cn is the mainland platform and a separate account
        // namespace, not a mirror, so it is an apiUrl override.
        baseUrl: 'https://api.moonshot.ai/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['moonshot'], openrouterPrefix: 'moonshotai/' },
    capabilities: ['Tool Use', 'Streaming', 'Vision', '1M Context'],
    keyUrl: 'https://platform.kimi.ai/console/api-keys',
    docsUrl: 'https://platform.kimi.ai/docs',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.QWEN,
    displayName: 'Qwen (QwenCloud)',
    blurb: 'Qwen3 Max, Plus and Flash on QwenCloud',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        auth: BEARER,
        path: '/chat/completions',
        // Compatible-mode enumerates six OpenAI APIs and /models is not one.
        listingPath: null,
      },
    ],
    pricing: { litellm: ['dashscope'], openrouterPrefix: 'qwen/' },
    capabilities: ['Tool Use', 'Streaming', 'Vision', '1M Context'],
    keyUrl: 'https://home.qwencloud.com/api-keys',
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.ZAI,
    displayName: 'Z.ai (GLM)',
    blurb: 'GLM 5.3 and the GLM coding models',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://api.z.ai/api/paas/v4',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: null,
      },
    ],
    pricing: { litellm: ['zai'], openrouterPrefix: 'z-ai/' },
    capabilities: ['Tool Use', 'Streaming', 'Vision'],
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    docsUrl: 'https://docs.z.ai/api-reference',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.GROQ,
    displayName: 'Groq',
    blurb: 'Open models at very low latency',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://api.groq.com/openai/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['groq'], openrouterPrefix: null },
    capabilities: ['Tool Use', 'Streaming'],
    keyUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.TOGETHER,
    displayName: 'Together AI',
    blurb: 'A large open-model catalog, and your own fine-tunes',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        // api.together.xyz is an undocumented legacy alias that still answers.
        baseUrl: 'https://api.together.ai/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['together_ai'], openrouterPrefix: null },
    capabilities: ['Tool Use', 'Streaming', 'Vision'],
    keyUrl: 'https://api.together.ai/settings/api-keys',
    docsUrl: 'https://docs.together.ai',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.FIREWORKS,
    displayName: 'Fireworks AI',
    blurb: 'Open models and your own fine-tunes on dedicated GPUs',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: null,
      },
    ],
    pricing: { litellm: ['fireworks_ai'], openrouterPrefix: null },
    capabilities: ['Tool Use', 'Streaming', 'Vision'],
    keyUrl: 'https://fireworks.ai/account/api-keys',
    docsUrl: 'https://docs.fireworks.ai',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.CEREBRAS,
    displayName: 'Cerebras',
    blurb: 'Open models on wafer-scale hardware',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://api.cerebras.ai/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['cerebras'], openrouterPrefix: null },
    capabilities: ['Tool Use', 'Streaming'],
    keyUrl: 'https://cloud.cerebras.ai',
    docsUrl: 'https://inference-docs.cerebras.ai',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.DEEPINFRA,
    displayName: 'DeepInfra',
    blurb: 'Open models per token, and your own weights on dedicated GPUs',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['deepinfra'], openrouterPrefix: null },
    capabilities: ['Tool Use', 'Streaming'],
    keyUrl: 'https://deepinfra.com/dash/api_keys',
    docsUrl: 'https://deepinfra.com/docs',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.NOVITA,
    displayName: 'Novita',
    blurb: 'Open models, and any Hugging Face repo on a dedicated endpoint',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://api.novita.ai/openai/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['novita'], openrouterPrefix: null },
    capabilities: ['Tool Use', 'Streaming'],
    keyUrl: 'https://novita.ai/settings/key-management',
    docsUrl: 'https://novita.ai/docs',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.BASETEN,
    displayName: 'Baseten',
    blurb: 'Open models, and your own weights or container',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://inference.baseten.co/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['baseten'], openrouterPrefix: null },
    capabilities: ['Tool Use', 'Streaming'],
    keyUrl: 'https://app.baseten.co/settings/api_keys',
    docsUrl: 'https://docs.baseten.co',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.NEBIUS,
    displayName: 'Nebius Token Factory',
    blurb: 'Open models, and LoRA adapters on curated bases',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        // Formerly Nebius AI Studio; api.studio.nebius.com still answers but
        // is undocumented.
        baseUrl: 'https://api.tokenfactory.nebius.com/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['nebius'], openrouterPrefix: null },
    capabilities: ['Tool Use', 'Streaming'],
    keyUrl: 'https://tokenfactory.nebius.com',
    docsUrl: 'https://docs.tokenfactory.nebius.com',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.SAMBANOVA,
    displayName: 'SambaNova',
    blurb: 'Open models on RDU hardware',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://api.sambanova.ai/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: null,
      },
    ],
    pricing: { litellm: ['sambanova'], openrouterPrefix: null },
    capabilities: ['Tool Use', 'Streaming'],
    keyUrl: 'https://cloud.sambanova.ai/apis',
    docsUrl: 'https://docs.sambanova.ai',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.COHERE,
    displayName: 'Cohere',
    blurb: 'Command and the Cohere retrieval models',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        // The native /v2/chat surface is not OpenAI-shaped, so chat rides the
        // Compatibility API; the model list stays on the native /v1/models.
        baseUrl: 'https://api.cohere.ai/compatibility/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['cohere_chat'], openrouterPrefix: 'cohere/' },
    capabilities: ['Tool Use', 'Streaming'],
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    docsUrl: 'https://docs.cohere.com/reference/about',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.DIGITALOCEAN,
    displayName: 'DigitalOcean Gradient',
    blurb: 'Open models on DigitalOcean serverless inference',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://inference.do-ai.run/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: null,
    capabilities: ['Streaming'],
    keyUrl: 'https://cloud.digitalocean.com/gen-ai',
    docsUrl: 'https://docs.digitalocean.com/products/gradient-ai-platform/',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.MODAL,
    displayName: 'Modal',
    blurb: 'Your own endpoints on Modal',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://inference.us-west.modal.direct/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: null,
    capabilities: ['Streaming'],
    keyUrl: 'https://modal.com/settings/tokens',
    docsUrl: 'https://modal.com/docs',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.AWS_BEDROCK,
    displayName: 'AWS Bedrock',
    blurb: 'Bedrock models in your own AWS account',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        // A Bedrock API key as a plain bearer; SigV4 is not needed here.
        baseUrl: 'https://bedrock-runtime.{bedrock.region||us-east-1}.amazonaws.com/openai/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['bedrock'], openrouterPrefix: null },
    capabilities: ['Tool Use', 'Streaming'],
    keyUrl: 'https://console.aws.amazon.com/bedrock',
    docsUrl: 'https://docs.aws.amazon.com/bedrock/',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.AZURE_AI_FOUNDRY,
    displayName: 'Azure AI Foundry',
    blurb: 'Foundry model deployments in your own Azure subscription',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://{azure.resourceName}.services.ai.azure.com/openai/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: null,
    capabilities: ['Tool Use', 'Streaming'],
    keyUrl: 'https://ai.azure.com',
    docsUrl: 'https://learn.microsoft.com/azure/ai-foundry/',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.RUNPOD,
    displayName: 'RunPod',
    blurb: 'Your own serverless vLLM worker',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        // RunPod always carries an endpoint in the path; there is no shared
        // base without one.
        baseUrl: 'https://api.runpod.ai/v2/{runpod.endpointId}/openai/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: null,
    capabilities: ['Streaming'],
    keyUrl: 'https://www.runpod.io/console/user/settings',
    docsUrl: 'https://docs.runpod.io',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.OPENAI,
    displayName: 'OpenAI',
    blurb: 'GPT-5 and the o-series',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://api.openai.com/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['openai'], openrouterPrefix: 'openai/' },
    capabilities: ['Tool Use', 'Streaming', 'Vision', 'JSON Mode'],
    keyUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.MISTRAL,
    displayName: 'Mistral AI',
    blurb: 'Mistral Large, Medium and Codestral',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://api.mistral.ai/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['mistral'], openrouterPrefix: 'mistralai/' },
    capabilities: ['Tool Use', 'Streaming', 'Vision'],
    keyUrl: 'https://console.mistral.ai/api-keys',
    docsUrl: 'https://docs.mistral.ai/api/',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.MINIMAX,
    displayName: 'MiniMax',
    blurb: 'MiniMax M3 and the M2 family',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://api.minimax.io/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['minimax'], openrouterPrefix: 'minimax/' },
    capabilities: ['Tool Use', 'Streaming', 'Vision', '1M Context'],
    keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    docsUrl: 'https://platform.minimax.io/docs/api-reference/text-chat-openai',
    verified: '2026-09-10',
  },
  {
    key: LlmProviderType.UPSTAGE,
    displayName: 'Upstage Solar',
    blurb: 'Solar Pro 4 and Solar Mini',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://api.upstage.ai/v1',
        auth: BEARER,
        path: '/chat/completions',
        // Undocumented, but the route answers. Attempted, and a miss degrades
        // to NO_MODEL_CONFIGURED rather than a guessed model id.
        listingPath: '/models',
      },
    ],
    pricing: null,
    capabilities: ['Tool Use', 'Streaming'],
    keyUrl: 'https://console.upstage.ai/api-keys',
    docsUrl: 'https://console.upstage.ai/docs/capabilities/generate/chat',
    verified: '2026-09-10',
  },
  {
    key: LlmProviderType.WRITER,
    displayName: 'Writer (Palmyra)',
    blurb: 'Palmyra X6, X5 and the domain models',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://api.writer.com/v1',
        auth: BEARER,
        // The one vendor whose chat path is not /chat/completions. A field,
        // not a reason to skip it.
        path: '/chat',
        listingPath: '/models',
      },
    ],
    pricing: null,
    capabilities: ['Tool Use', 'Streaming', '1M Context'],
    keyUrl: 'https://app.writer.com/aistudio/organization/api-keys',
    docsUrl: 'https://dev.writer.com/api-reference/completion-api/chat-completion',
    verified: '2026-09-10',
  },
  {
    key: LlmProviderType.QIANFAN,
    displayName: 'Baidu ERNIE (Qianfan)',
    blurb: 'ERNIE 5.1 and the open models Qianfan hosts',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://qianfan.baidubce.com/v2',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: null,
    capabilities: ['Tool Use', 'Streaming'],
    keyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
    docsUrl: 'https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb',
    verified: '2026-09-10',
  },
  {
    key: LlmProviderType.HUNYUAN,
    displayName: 'Tencent Hunyuan (TokenHub)',
    blurb: 'Hunyuan, plus DeepSeek, GLM, Kimi and MiniMax on TokenHub',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/v1',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['tencent'], openrouterPrefix: null },
    capabilities: ['Tool Use', 'Streaming'],
    keyUrl: 'https://console.cloud.tencent.com/tokenhub/apikey',
    docsUrl: 'https://www.tencentcloud.com/act/pro/tokenhub',
    verified: '2026-09-10',
  },
  {
    key: LlmProviderType.VOLCENGINE,
    displayName: 'ByteDance Doubao (Ark)',
    blurb: 'Doubao Seed 2.0, and DeepSeek on Ark',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        // BytePlus and Volcengine are separate products with separate
        // accounts, keys and model names, so the edition is chosen.
        baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
        bases: {
          international: 'https://ark.ap-southeast.bytepluses.com/api/v3',
          mainland: 'https://ark.cn-beijing.volces.com/api/v3',
        },
        basesField: 'ark.edition',
        auth: BEARER,
        path: '/chat/completions',
        // Ark has no listing: the vendor's own SDK ships no models resource.
        listingPath: null,
      },
    ],
    pricing: null,
    capabilities: ['Tool Use', 'Streaming', 'Vision'],
    keyUrl: 'https://ai.byteplus.com/ark/region:ap-southeast-1/apikey',
    docsUrl: 'https://docs.byteplus.com/en/docs/ModelArk/1494384',
    verified: '2026-09-10',
  },
  {
    key: LlmProviderType.SPARK,
    displayName: 'iFlytek Spark',
    blurb: 'Spark X2, X1.5 and the 4.0 Ultra line',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        // X2 and X1.5 both answer to the model id `spark-x`, so the model
        // field cannot tell them apart and the generation is required.
        baseUrl: 'https://spark-api-open.xf-yun.com/x2',
        bases: {
          x2: 'https://spark-api-open.xf-yun.com/x2',
          'x1.5': 'https://spark-api-open.xf-yun.com/v2',
          legacy: 'https://spark-api-open.xf-yun.com/v1',
        },
        basesField: 'spark.generation',
        auth: BEARER,
        path: '/chat/completions',
        listingPath: null,
      },
    ],
    pricing: null,
    capabilities: ['Tool Use', 'Streaming'],
    keyUrl: 'https://console.xfyun.cn/services/bmx1',
    docsUrl: 'https://www.xfyun.cn/doc/spark/X1http.html',
    verified: '2026-09-10',
  },
  {
    key: LlmProviderType.OPENROUTER,
    displayName: 'OpenRouter',
    blurb: 'One key across hundreds of models and providers',
    protocols: [
      {
        protocol: 'chat_completions',
        preferred: true,
        baseUrl: 'https://openrouter.ai/api/v1',
        auth: {
          scheme: 'bearer',
        // App attribution. X-OpenRouter-Title superseded X-Title, which is
        // still accepted for backwards compatibility.
          extraHeaders: { 'HTTP-Referer': 'https://almyty.com', 'X-OpenRouter-Title': 'almyty' },
        },
        path: '/chat/completions',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['openrouter'], openrouterPrefix: '' },
    capabilities: ['Tool Use', 'Streaming', 'Vision'],
    keyUrl: 'https://openrouter.ai/keys',
    docsUrl: 'https://openrouter.ai/docs',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.ANTHROPIC,
    displayName: 'Anthropic',
    blurb: 'Claude Opus, Sonnet and Haiku',
    protocols: [
      {
        protocol: 'anthropic_messages',
        preferred: true,
        baseUrl: 'https://api.anthropic.com/v1',
        // Not a bearer: Anthropic takes the key in x-api-key alongside a
        // required API version header.
        auth: { scheme: 'header', header: 'x-api-key', extraHeaders: { 'anthropic-version': '2023-06-01' } },
        path: '/messages',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['anthropic'], openrouterPrefix: 'anthropic/' },
    capabilities: ['Tool Use', 'Streaming', 'Vision', '1M Context'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    docsUrl: 'https://docs.anthropic.com/en/api/',
    verified: '2026-09-09',
  },
  {
    key: LlmProviderType.GOOGLE,
    displayName: 'Google Gemini',
    blurb: 'Gemini Pro and Flash on the Gemini Developer API',
    protocols: [
      {
        protocol: 'gemini_generate_content',
        preferred: true,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        // The key goes in a header: the ?key= query parameter still works but
        // Google's own guidance calls out that it leaks through URL scans.
        auth: { scheme: 'header', header: 'x-goog-api-key' },
        path: '/models',
        listingPath: '/models',
      },
    ],
    pricing: { litellm: ['gemini'], openrouterPrefix: 'google/' },
    capabilities: ['Tool Use', 'Streaming', 'Vision', '1M Context'],
    keyUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    verified: '2026-09-09',
  },];

const BY_KEY = new Map(PROVIDER_PROFILES.map((p) => [p.key, p] as const));

export function providerProfile(type: LlmProviderType): ProviderProfile | undefined {
  return BY_KEY.get(type);
}

/** The binding a call uses by default: the preferred one, else the first. */
export function preferredBinding(profile: ProviderProfile): ProtocolBinding {
  return profile.protocols.find((b) => b.preferred) ?? profile.protocols[0];
}

/** A vendor's binding for one protocol, when it speaks it. */
export function bindingFor(profile: ProviderProfile, protocol: Protocol): ProtocolBinding | undefined {
  return profile.protocols.find((b) => b.protocol === protocol);
}

/** Read a dotted path out of a provider's configuration. */
function at(configuration: Record<string, any> | undefined, path: string): string | undefined {
  const value = path.split('.').reduce<any>((acc, part) => (acc == null ? acc : acc[part]), configuration);
  return typeof value === 'string' ? value : undefined;
}

/**
 * The base URL a binding resolves to for a given configuration.
 *
 * A stored `apiUrl` always wins, which is how a customer reaches a
 * regional or self-hosted variant we do not enumerate. Otherwise: the
 * selected base when the vendor serves several, then `{dotted.path}`
 * substitution.
 */
export function bindingBaseUrl(binding: ProtocolBinding, configuration: Record<string, any> = {}): string {
  const explicit = configuration.apiUrl;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  let template = binding.baseUrl;
  if (binding.bases && binding.basesField) {
    const selected = at(configuration, binding.basesField);
    if (selected && binding.bases[selected]) template = binding.bases[selected];
  }
  return template.replace(/\{([^}]+)\}/g, (_match, path: string) => {
    const [dotted, fallback = ''] = path.split('||');
    return at(configuration, dotted.trim()) ?? fallback.trim();
  });
}

/** The base URL this profile resolves to on its preferred protocol. */
export function profileBaseUrl(profile: ProviderProfile, configuration: Record<string, any> = {}): string {
  return bindingBaseUrl(preferredBinding(profile), configuration);
}

/**
 * Sent on every outbound call regardless of vendor, so a profile never
 * has to restate them.
 */
export const COMMON_HEADERS: Record<string, string> = {
  'User-Agent': 'almyty/1.0',
  'Content-Type': 'application/json',
};

/** The headers a binding sends for a key, matching the entity's switch exactly. */
export function bindingAuthHeaders(binding: ProtocolBinding, apiKey: string | undefined): Record<string, string> {
  if (binding.auth.scheme === 'none' || !apiKey) return { ...COMMON_HEADERS };
  const keyed: Record<string, string> =
    binding.auth.scheme === 'bearer'
      ? { Authorization: `Bearer ${apiKey}` }
      : { [binding.auth.header]: apiKey };
  return { ...keyed, ...(binding.auth.extraHeaders ?? {}), ...COMMON_HEADERS };
}

/** The headers this profile sends on its preferred protocol. */
export function profileAuthHeaders(profile: ProviderProfile, apiKey: string | undefined): Record<string, string> {
  return bindingAuthHeaders(preferredBinding(profile), apiKey);
}
