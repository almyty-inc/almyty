import { LlmProviderType } from '../../entities/llm-provider.entity';

/**
 * A vendor as data.
 *
 * Adding an inference vendor used to mean editing eight files and opening
 * a pull request: an enum member, a base URL case, an auth case, two
 * dispatch lists, a model-list case, a price-feed row, a usage-capability
 * row, five catalog maps, and the same again in the frontend. The result
 * was predictable. The list grew by whoever was easiest to wire rather
 * than by who mattered, three enum-derived guards had to be invented to
 * catch the half-finished ones, and every few weeks somebody reasonably
 * asked why the list contained what it contained.
 *
 * Almost none of that is code. A vendor is a base URL, an auth header, a
 * chat path, a listing shape, a pricing source and a couple of quirks.
 * That is a row.
 *
 * This file is the shape of that row and the built-in set. It is
 * deliberately the ONLY place a plain OpenAI-compatible vendor is
 * described; `vendor-card.spec.ts` proves each card reproduces exactly
 * what the entity's switches produce today, so nothing changes behaviour
 * when the switches are replaced by a lookup.
 *
 * What is NOT expressible here stays in code, and each is a real reason
 * rather than an awkward one:
 *   vertex_ai  mints a one-hour OAuth token per call from a service
 *              account key, which no static description can do
 *   custom     carries tenant-supplied headers that must be sanitised
 *
 * Every other vendor, including the ones with quirks that were once used
 * as grounds to exclude them, is a row below.
 */

/** How the key reaches the vendor. */
export type VendorAuth =
  /** `Authorization: Bearer <key>`, the overwhelming majority. */
  | { scheme: 'bearer'; extraHeaders?: Record<string, string> }
  /** A named header carrying the raw key, e.g. Azure's `api-key`. */
  | { scheme: 'header'; header: string; extraHeaders?: Record<string, string> }
  /** The vendor supplies its own headers elsewhere; emit none here. */
  | { scheme: 'none' };

export interface VendorCard {
  key: LlmProviderType;
  displayName: string;
  /** One-line description of what this vendor serves, for the picker. */
  blurb: string;
  /**
   * The base URL. When the vendor serves more than one, `bases` maps the
   * value of `basesField` to a base and `baseUrl` is the default. This is
   * how a quirk becomes a field: Spark's model generation and Ark's
   * international-or-mainland edition both live here rather than being
   * reasons the vendor could not be added.
   */
  baseUrl: string;
  bases?: Record<string, string>;
  /** Dotted path into `configuration` selecting a base, e.g. 'spark.generation'. */
  basesField?: string;
  auth: VendorAuth;
  /** Appended to the base for chat. Writer serves `/chat`; everyone else `/chat/completions`. */
  chatPath: string;
  /**
   * Path appended to the base to list models, or null when the vendor
   * documents none. Null is a normal answer, not a defect: the user names
   * the model and a miss surfaces as NO_MODEL_CONFIGURED.
   */
  listingPath: string | null;
  /** Where live prices come from, or null when the vendor is absent from the feed. */
  pricing: { litellm: string[]; openrouterPrefix: string | null } | null;
  capabilities: string[];
  keyUrl: string;
  docsUrl: string;
  /** Docs URL and the date the surface above was last checked against it. */
  verified: string;
}

const BEARER: VendorAuth = { scheme: 'bearer' };

/**
 * The built-in vendors. Ordered as the create form offers them: the
 * first-party model families people name by brand, then the independent
 * inference hosts, then the aggregators.
 */
export const VENDOR_CARDS: VendorCard[] = [
  {
    key: LlmProviderType.OPENAI,
    displayName: 'OpenAI',
    blurb: 'GPT-5 and the o-series',
    baseUrl: 'https://api.openai.com/v1',
    auth: BEARER,
    chatPath: '/chat/completions',
    listingPath: '/models',
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
    baseUrl: 'https://api.mistral.ai/v1',
    auth: BEARER,
    chatPath: '/chat/completions',
    listingPath: '/models',
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
    baseUrl: 'https://api.minimax.io/v1',
    auth: BEARER,
    chatPath: '/chat/completions',
    listingPath: '/models',
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
    baseUrl: 'https://api.upstage.ai/v1',
    auth: BEARER,
    chatPath: '/chat/completions',
    // Undocumented, but the route answers. Attempted, and a miss degrades
    // to NO_MODEL_CONFIGURED rather than a guessed model id.
    listingPath: '/models',
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
    baseUrl: 'https://api.writer.com/v1',
    auth: BEARER,
    // The one vendor whose chat path is not /chat/completions. A field,
    // not a reason to skip it.
    chatPath: '/chat',
    listingPath: '/models',
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
    baseUrl: 'https://qianfan.baidubce.com/v2',
    auth: BEARER,
    chatPath: '/chat/completions',
    listingPath: '/models',
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
    baseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/v1',
    auth: BEARER,
    chatPath: '/chat/completions',
    listingPath: '/models',
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
    // BytePlus and Volcengine are separate products with separate
    // accounts, keys and model names, so the edition is chosen.
    baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    bases: {
      international: 'https://ark.ap-southeast.bytepluses.com/api/v3',
      mainland: 'https://ark.cn-beijing.volces.com/api/v3',
    },
    basesField: 'ark.edition',
    auth: BEARER,
    chatPath: '/chat/completions',
    // Ark has no listing: the vendor's own SDK ships no models resource.
    listingPath: null,
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
    chatPath: '/chat/completions',
    listingPath: null,
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
    baseUrl: 'https://openrouter.ai/api/v1',
    auth: {
      scheme: 'bearer',
      // App attribution. X-OpenRouter-Title superseded X-Title, which is
      // still accepted for backwards compatibility.
      extraHeaders: { 'HTTP-Referer': 'https://almyty.com', 'X-OpenRouter-Title': 'almyty' },
    },
    chatPath: '/chat/completions',
    listingPath: '/models',
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
    baseUrl: 'https://api.anthropic.com/v1',
    // Not a bearer: Anthropic takes the key in x-api-key alongside a
    // required API version header.
    auth: { scheme: 'header', header: 'x-api-key', extraHeaders: { 'anthropic-version': '2023-06-01' } },
    chatPath: '/messages',
    listingPath: '/models',
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
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    // The key goes in a header: the ?key= query parameter still works but
    // Google's own guidance calls out that it leaks through URL scans.
    auth: { scheme: 'header', header: 'x-goog-api-key' },
    chatPath: '/models',
    listingPath: '/models',
    pricing: { litellm: ['gemini'], openrouterPrefix: 'google/' },
    capabilities: ['Tool Use', 'Streaming', 'Vision', '1M Context'],
    keyUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    verified: '2026-09-09',
  },
];

const BY_KEY = new Map(VENDOR_CARDS.map((c) => [c.key, c] as const));

export function vendorCard(type: LlmProviderType): VendorCard | undefined {
  return BY_KEY.get(type);
}

/** Read a dotted path out of a provider's configuration. */
function at(configuration: Record<string, any> | undefined, path: string): string | undefined {
  const value = path.split('.').reduce<any>((acc, part) => (acc == null ? acc : acc[part]), configuration);
  return typeof value === 'string' ? value : undefined;
}

/**
 * The base URL this card resolves to for a given configuration: the
 * selected base when the vendor has several, otherwise its only one. A
 * stored `apiUrl` always wins, which is how a customer reaches a regional
 * or self-hosted variant we do not enumerate.
 */
export function cardBaseUrl(card: VendorCard, configuration: Record<string, any> = {}): string {
  const explicit = configuration.apiUrl;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (card.bases && card.basesField) {
    const selected = at(configuration, card.basesField);
    if (selected && card.bases[selected]) return card.bases[selected];
  }
  return card.baseUrl;
}

/**
 * Sent on every outbound call regardless of vendor, so a card never has
 * to restate them.
 */
export const COMMON_HEADERS: Record<string, string> = {
  'User-Agent': 'almyty/1.0',
  'Content-Type': 'application/json',
};

/** The headers this card sends for a key, matching the entity's switch exactly. */
export function cardAuthHeaders(card: VendorCard, apiKey: string | undefined): Record<string, string> {
  if (card.auth.scheme === 'none' || !apiKey) return { ...COMMON_HEADERS };
  const keyed: Record<string, string> =
    card.auth.scheme === 'bearer' ? { Authorization: `Bearer ${apiKey}` } : { [card.auth.header]: apiKey };
  return { ...keyed, ...(card.auth.extraHeaders ?? {}), ...COMMON_HEADERS };
}
