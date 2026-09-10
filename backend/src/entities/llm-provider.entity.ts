import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { VersionedEntity } from 'typeorm-versions';
import { Organization } from './organization.entity';
import { Credential } from './credential.entity';
import { sanitizeHeaders } from '../common/security/url-validator';
import { encryptField, decryptField, isEncrypted } from '../common/security/field-crypto';
import { Conversation } from './conversation.entity';
import { UsageMetric } from './usage-metric.entity';

export enum LlmProviderType {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
  MISTRAL = 'mistral',
  XAI = 'xai',
  DEEPSEEK = 'deepseek',
  GROQ = 'groq',
  TOGETHER = 'together',
  OPENROUTER = 'openrouter',
  AZURE_OPENAI = 'azure_openai',
  AWS_BEDROCK = 'aws_bedrock',
  COHERE = 'cohere',
  HUGGINGFACE = 'huggingface',
  OLLAMA = 'ollama',
  // OpenAI-compatible inference hosts (chat, streaming and tool calling
  // ride the OpenAI dispatch path). Details per vendor in
  // docs/design/call-only-vendors.md.
  FIREWORKS = 'fireworks',
  CEREBRAS = 'cerebras',
  DEEPINFRA = 'deepinfra',
  NOVITA = 'novita',
  PERPLEXITY = 'perplexity',
  ZAI = 'zai',
  BASETEN = 'baseten',
  NEBIUS = 'nebius',
  SAMBANOVA = 'sambanova',
  // First-party model families a customer names by brand. Both are
  // OpenAI-compatible and both run separate international and mainland
  // China endpoints whose API keys are NOT interchangeable; the default is
  // the international one and the other is reachable via apiUrl.
  MOONSHOT = 'moonshot',
  QWEN = 'qwen',
  MINIMAX = 'minimax',
  UPSTAGE = 'upstage',
  // Writer is OpenAI-shaped in body but not in path: chat is POST /v1/chat,
  // and its model list is {models:[{id,name}]} where name is a display
  // label. It gets its own dispatch for both reasons.
  WRITER = 'writer',
  // Chinese vendors, on the plain-bearer OpenAI-compatible surface each now
  // publishes alongside its signed legacy API. None needs a request
  // signature on the surface we call. Verified 2026-09-10.
  QIANFAN = 'qianfan',
  HUNYUAN = 'hunyuan',
  VOLCENGINE = 'volcengine',
  // iFlytek Spark. Its model generations sit on different bases and the
  // current two share the model id `spark-x`, so the generation is a
  // required field driving the base rather than something to guess.
  SPARK = 'spark',
  // The customer's own cloud, as a CALL target rather than a deployment
  // target. Each is a distinct product from the neighbouring type it is
  // easily confused with: vertex_ai is not the Gemini Developer API
  // (`google`), and azure_ai_foundry is not Azure OpenAI.
  VERTEX_AI = 'vertex_ai',
  AZURE_AI_FOUNDRY = 'azure_ai_foundry',
  // Vendor serverless inference we can call without deploying anything.
  DIGITALOCEAN = 'digitalocean',
  RUNPOD = 'runpod',
  MODAL = 'modal',
  CUSTOM = 'custom',
}

export enum LlmProviderStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
  MAINTENANCE = 'maintenance',
}

export interface LlmProviderConfig {
  /**
   * Read-through shim only. The inference key lives in the Credential
   * row `credentialId` points at; this field is read when no reference
   * is set (rows the startup backfill has not moved) and is never
   * written by the service any more. TODO(2026-12-01): drop the shim.
   */
  apiKey?: string;
  /**
   * Read-through shim for the admin/usage key (P7), same contract as
   * `apiKey`: the value lives in the row `usageCredentialId` points at.
   * This is a DIFFERENT credential scope than the inference key: OpenAI
   * needs an Admin key, Anthropic an org Admin key. Read via
   * getDecryptedUsageApiKey(). TODO(2026-12-01): drop the shim.
   */
  usageApiKey?: string;
  apiUrl?: string;
  apiVersion?: string;
  model?: string;
  /**
   * Embedding model override for embedding-capable providers. Currently
   * honored by the memory EmbeddingService for Ollama providers
   * (default: nomic-embed-text). Embedding dimensionality varies per
   * model; the memory store records model + dim per vector.
   */
  embeddingModel?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  timeout?: number;
  retries?: number;
  rateLimits?: {
    requestsPerMinute?: number;
    requestsPerHour?: number;
    tokensPerMinute?: number;
    tokensPerHour?: number;
  };
  // Provider-specific configurations
  azure?: {
    deploymentName?: string;
    resourceName?: string;
    apiVersion?: string;
  };
  bedrock?: {
    /** Selects the bedrock-runtime host and the model set available there. */
    region?: string;
    /**
     * SigV4 material. Unused on the OpenAI-compatible surface, which takes
     * a Bedrock API key as a bearer token; kept because existing rows carry
     * it and it is still masked in the API view.
     */
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };
  huggingface?: {
    endpoint?: string;
    taskType?: string;
  };
  /** Google Vertex AI: the customer's own GCP project and region. */
  vertex?: {
    projectId?: string;
    /** `global` (the default) or a region such as `us-central1`. */
    location?: string;
  };
  /**
   * RunPod always names an endpoint in the URL. For the public catalog
   * that is a shared model slug (`gpt-oss-120b`); for a customer's own
   * serverless worker it is their endpoint id.
   */
  runpod?: {
    endpointId?: string;
  };
  /**
   * Volcengine Ark ships as two products with separate accounts, separate
   * key namespaces and different model naming: BytePlus ModelArk for
   * everyone outside mainland China, and Volcengine for inside it. A key
   * from one does not work against the other, and `seed-2-0-lite-260228`
   * on BytePlus is `doubao-seed-2-0-lite-260215` on Volcengine, so this is
   * a choice the customer has to make rather than a host we can guess.
   */
  ark?: {
    edition?: 'international' | 'mainland';
  };
  /**
   * iFlytek Spark serves each model generation on its own base, and the
   * current two both answer to the model id `spark-x`, so the model field
   * cannot tell them apart. Defaulting would put most users on the wrong
   * generation with no error saying so.
   */
  spark?: {
    generation?: 'x2' | 'x1.5' | 'legacy';
  };
  custom?: {
    headers?: Record<string, string>;
    authMethod?: 'bearer' | 'api_key' | 'custom';
    requestFormat?: 'openai' | 'anthropic' | 'custom';
  };
}

/** What the API shows about the credential backing a provider. Never the config. */
export interface LlmProviderCredentialRef {
  id: string;
  name: string | null;
  connectorKey: string | null;
  healthStatus: string | null;
}

export interface LlmProviderCredentialRefs {
  credentialRef?: LlmProviderCredentialRef | null;
  usageCredentialRef?: LlmProviderCredentialRef | null;
}

@Entity('llm_providers')
@VersionedEntity()
@Index(['organizationId', 'name'])
@Index(['type', 'status'])
export class LlmProvider {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({
    type: 'varchar',
  })
  type: LlmProviderType;

  @Column({
    type: 'varchar',
    default: LlmProviderStatus.ACTIVE,
  })
  status: LlmProviderStatus;

  @Column()
  organizationId: string;

  /**
   * Team-scoping. visibility='org' (default) is org-wide; 'team'
   * requires teamId. Constraint enforced at DB level via
   * 1745340000000-TeamScopingPerEntity. Listing filters use
   * AccessPolicyService.applyListFilter.
   */
  @Column({ type: 'varchar', length: 8, default: 'org' })
  visibility: 'org' | 'team';

  @Column({ type: 'uuid', nullable: true })
  teamId: string | null;

  /** The inference key: a Credential row in the org's store. */
  @Column({ type: 'uuid', nullable: true })
  credentialId: string | null;

  /** The usage/admin key (a different scope at the vendor), also a Credential row. */
  @Column({ type: 'uuid', nullable: true })
  usageCredentialId: string | null;

  @Column({ type: 'json' })
  configuration: LlmProviderConfig;

  @Column({ type: 'json', nullable: true })
  capabilities: {
    supportedModels: string[];
    maxTokens: number;
    supportsFunctionCalling: boolean;
    supportsStreaming: boolean;
    supportsBatching: boolean;
    supportsVision: boolean;
    supportsAudio: boolean;
    supportsToolUse: boolean;
    supportedToolFormats: string[]; // 'openai', 'anthropic', 'custom'
  };

  @Column({ type: 'json', nullable: true })
  metadata: {
    version?: string;
    region?: string;
    endpoint?: string;
    lastHealthCheck?: string;
    modelInfo?: {
      contextWindow?: number;
      inputTokenCost?: number;
      outputTokenCost?: number;
      currency?: string;
    };
  };

  @Column({ default: 0 })
  totalRequests: number;

  @Column({ default: 0 })
  successfulRequests: number;

  @Column({ default: 0 })
  totalTokensUsed: number;

  @Column({ type: 'float', default: 0 })
  totalCost: number; // in cents

  @Column({ nullable: true })
  lastRequestAt: Date;

  @Column({ nullable: true })
  lastHealthCheckAt: Date;

  @Column({ default: true })
  isHealthy: boolean;

  @Column({ nullable: true })
  lastError: string;

  /** When lastError was recorded; compare with lastSuccessAt to know if it is current. */
  @Column({ nullable: true })
  lastErrorAt: Date;

  @Column({ nullable: true })
  lastSuccessAt: Date;


  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, org => org.llmProviders, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  // Eager: every repository read of a provider carries its credential so
  // the sync key getters work at every existing call site (chat runner,
  // embeddings, usage, A2A, health) without each of them resolving first.
  @ManyToOne(() => Credential, { nullable: true, eager: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'credentialId' })
  credential: Credential | null;

  @ManyToOne(() => Credential, { nullable: true, eager: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'usageCredentialId' })
  usageCredential: Credential | null;

  @OneToMany(() => Conversation, conversation => conversation.provider)
  sessions: Conversation[];

  @OneToMany(() => UsageMetric, metric => metric.llmProvider)
  usageMetrics: UsageMetric[];

  // Methods
  isActive(): boolean {
    return this.status === LlmProviderStatus.ACTIVE;
  }

  checkHealth(): boolean {
    return this.isHealthy && this.isActive();
  }

  getSuccessRate(): number {
    if (this.totalRequests === 0) return 0;
    return (this.successfulRequests / this.totalRequests) * 100;
  }

  getAverageCostPerRequest(): number {
    if (this.totalRequests === 0) return 0;
    return this.totalCost / this.totalRequests;
  }

  getAverageTokensPerRequest(): number {
    if (this.totalRequests === 0) return 0;
    return this.totalTokensUsed / this.totalRequests;
  }

  incrementUsage(tokens: number, cost: number, success: boolean = true): void {
    this.totalRequests++;
    if (success) {
      this.successfulRequests++;
    }
    this.totalTokensUsed += tokens;
    this.totalCost += cost;
    this.lastRequestAt = new Date();
  }

  updateHealthStatus(isHealthy: boolean, error?: string): void {
    this.isHealthy = isHealthy;
    this.lastHealthCheckAt = new Date();
    
    if (!isHealthy && this.status === LlmProviderStatus.ACTIVE) {
      this.status = LlmProviderStatus.ERROR;
      this.lastError = error;
    } else if (isHealthy && this.status === LlmProviderStatus.ERROR) {
      this.status = LlmProviderStatus.ACTIVE;
      this.lastError = null;
    }
  }

  supportsToolUse(): boolean {
    return this.capabilities?.supportsToolUse || false;
  }

  supportsFunctionCalling(): boolean {
    return this.capabilities?.supportsFunctionCalling || false;
  }

  supportsStreaming(): boolean {
    return this.capabilities?.supportsStreaming || false;
  }

  getMaxTokens(): number {
    return this.capabilities?.maxTokens || this.configuration.maxTokens || 4096;
  }

  getSupportedModels(): string[] {
    return this.capabilities?.supportedModels || [this.configuration.model || 'default'];
  }

  getApiUrl(): string {
    switch (this.type) {
      case LlmProviderType.OPENAI:
        return this.configuration.apiUrl || 'https://api.openai.com/v1';
      case LlmProviderType.ANTHROPIC:
        return this.configuration.apiUrl || 'https://api.anthropic.com/v1';
      case LlmProviderType.GOOGLE:
        return this.configuration.apiUrl || 'https://generativelanguage.googleapis.com/v1beta';
      case LlmProviderType.MISTRAL:
        return this.configuration.apiUrl || 'https://api.mistral.ai/v1';
      case LlmProviderType.XAI:
        return this.configuration.apiUrl || 'https://api.x.ai/v1';
      case LlmProviderType.DEEPSEEK:
        // Current docs document the base with no /v1 segment: chat at
        // <base>/chat/completions, models at <base>/models. Verified
        // 2026-09-09.
        return this.configuration.apiUrl || 'https://api.deepseek.com';
      case LlmProviderType.GROQ:
        return this.configuration.apiUrl || 'https://api.groq.com/openai/v1';
      case LlmProviderType.TOGETHER:
        // api.together.ai is the documented host; api.together.xyz is an
        // undocumented legacy alias that still answers. Verified 2026-09-09.
        return this.configuration.apiUrl || 'https://api.together.ai/v1';
      case LlmProviderType.OPENROUTER:
        return this.configuration.apiUrl || 'https://openrouter.ai/api/v1';
      // OpenAI-compatible inference hosts. Each default is the vendor's
      // documented OpenAI base (chat at <base>/chat/completions, model
      // list at <base>/models); verified 2026-09-08, see
      // docs/design/call-only-vendors.md. A configured apiUrl always wins.
      case LlmProviderType.FIREWORKS:
        return this.configuration.apiUrl || 'https://api.fireworks.ai/inference/v1';
      case LlmProviderType.CEREBRAS:
        return this.configuration.apiUrl || 'https://api.cerebras.ai/v1';
      case LlmProviderType.DEEPINFRA:
        return this.configuration.apiUrl || 'https://api.deepinfra.com/v1/openai';
      case LlmProviderType.NOVITA:
        // /openai/v1 satisfies both the documented chat curl and the
        // documented model-list curl; the bare /openai form is only the
        // SDK base_url. Re-verified 2026-09-09.
        return this.configuration.apiUrl || 'https://api.novita.ai/openai/v1';
      case LlmProviderType.PERPLEXITY:
        // The Agent API base. Chat is Responses-shaped at <base>/responses
        // (alias of <base>/agent), NOT chat-completions shaped, so
        // Perplexity has its own dispatch. The legacy Sonar
        // chat-completions alias on the bare host retires 2026-09-27 and is
        // not reachable through this type; the Router API
        // (https://api.perplexity.ai/router/v1, private preview) serves
        // /responses too and can be set as apiUrl. Verified 2026-09-09.
        return this.configuration.apiUrl || 'https://api.perplexity.ai/v1';
      case LlmProviderType.ZAI:
        return this.configuration.apiUrl || 'https://api.z.ai/api/paas/v4';
      case LlmProviderType.BASETEN:
        return this.configuration.apiUrl || 'https://inference.baseten.co/v1';
      case LlmProviderType.NEBIUS:
        // Nebius AI Studio is now Nebius Token Factory; the old
        // api.studio.nebius.com host still answers but is undocumented.
        return this.configuration.apiUrl || 'https://api.tokenfactory.nebius.com/v1';
      case LlmProviderType.SAMBANOVA:
        return this.configuration.apiUrl || 'https://api.sambanova.ai/v1';
      case LlmProviderType.MOONSHOT:
        // The international Kimi platform. api.moonshot.cn is the mainland
        // China platform: a SEPARATE account namespace, not a mirror - a
        // key from one 401s against the other - so it is an apiUrl override
        // rather than a fallback. Verified 2026-09-09.
        return this.configuration.apiUrl || 'https://api.moonshot.ai/v1';
      case LlmProviderType.QWEN:
        // QwenCloud (formerly DashScope, then Alibaba Cloud Model Studio),
        // international endpoint. Mainland China is
        // https://dashscope.aliyuncs.com/compatible-mode/v1 and a Model
        // Studio workspace is
        // https://{workspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1;
        // both are apiUrl overrides. Keys are bound to the region they were
        // minted in. Verified 2026-09-09.
        return this.configuration.apiUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
      case LlmProviderType.MINIMAX:
        // The international platform. The mainland China platform is a
        // separate account namespace at https://api.minimax.cn;
        // api.minimaxi.com is a legacy alias that still answers but appears
        // in neither platform's current docs. Verified 2026-09-10.
        return this.configuration.apiUrl || 'https://api.minimax.io/v1';
      case LlmProviderType.UPSTAGE:
        // Solar. kr.api.upstage.ai is a closed-beta Korea residency host
        // that serves document models only, not chat, so there is no region
        // to choose here. Verified 2026-09-10.
        return this.configuration.apiUrl || 'https://api.upstage.ai/v1';
      case LlmProviderType.WRITER:
        // Chat is POST <base>/chat, NOT <base>/chat/completions, so this
        // base is only correct together with the Writer dispatch case.
        // Verified 2026-09-10.
        return this.configuration.apiUrl || 'https://api.writer.com/v1';
      case LlmProviderType.QIANFAN:
        // Baidu ERNIE on Qianfan v2. The AK/SK-to-access-token exchange the
        // v1 API needed is gone here: the key is one opaque
        // `bce-v3/ALTAK-.../...` string used as a plain bearer. Verified
        // 2026-09-10.
        return this.configuration.apiUrl || 'https://qianfan.baidubce.com/v2';
      case LlmProviderType.HUNYUAN:
        // TokenHub, Tencent's model gateway, international host. Tencent's
        // own docs say the original Hunyuan platform is migrating here and
        // has stopped taking new model services, so the direct host
        // (https://api.hunyuan.cloud.tencent.com/v1) is an apiUrl override
        // rather than the default, as is the mainland TokenHub host
        // (https://tokenhub.tencentcloudmaas.com/v1). No TC3 request
        // signature is involved on this surface. Verified 2026-09-10.
        return this.configuration.apiUrl || 'https://tokenhub-intl.tencentcloudmaas.com/v1';
      case LlmProviderType.VOLCENGINE:
        // ByteDance Doubao. Two products, not two hosts for one product:
        // BytePlus ModelArk outside mainland China, Volcengine inside it,
        // with separate accounts, keys and model names. International is
        // the default because it is the one a non-China customer can sign
        // up for. Verified 2026-09-10.
        return (
          this.configuration.apiUrl ||
          (this.configuration.ark?.edition === 'mainland'
            ? 'https://ark.cn-beijing.volces.com/api/v3'
            : 'https://ark.ap-southeast.bytepluses.com/api/v3')
        );
      case LlmProviderType.SPARK: {
        // Each generation is its own base and the current two share the
        // model id `spark-x`, so this is chosen, never inferred. X2 is the
        // current flagship; legacy carries 4.0Ultra and the generalv3
        // line, whose Max package retired 2026-03-10 into Ultra.
        // Verified 2026-09-10.
        const path = { x2: 'x2', 'x1.5': 'v2', legacy: 'v1' }[this.configuration.spark?.generation ?? 'x2'];
        return this.configuration.apiUrl || `https://spark-api-open.xf-yun.com/${path}`;
      }
      case LlmProviderType.VERTEX_AI: {
        // Vertex's OpenAI-compatible surface. `global` uses the unprefixed
        // host; a region uses the {region}-aiplatform host. This surface
        // serves Gemini on Vertex and self-deployed Model Garden endpoints.
        // Partner models (Claude, Mistral, Grok) are NOT here - they are
        // :rawPredict with each vendor's native body. Verified 2026-09-09.
        const project = this.configuration.vertex?.projectId ?? '';
        const location = this.configuration.vertex?.location || 'global';
        const host = location === 'global'
          ? 'https://aiplatform.googleapis.com'
          : `https://${location}-aiplatform.googleapis.com`;
        return this.configuration.apiUrl
          || `${host}/v1/projects/${project}/locations/${location}/endpoints/openapi`;
      }
      case LlmProviderType.AZURE_AI_FOUNDRY: {
        // Microsoft Foundry (formerly Azure AI Studio / Azure AI Foundry).
        // The /openai/v1 route is the current one and needs no api-version;
        // the older {resource}.services.ai.azure.com/models route rides the
        // Azure AI Inference beta SDK, retired 2026-08-26. `model` is the
        // customer's deployment name. Verified 2026-09-09.
        const resourceName = this.configuration.azure?.resourceName ?? '';
        return this.configuration.apiUrl || `https://${resourceName}.services.ai.azure.com/openai/v1`;
      }
      case LlmProviderType.DIGITALOCEAN:
        // DigitalOcean Gradient serverless inference. Nothing to deploy and
        // no project or region in the URL - a model access key is the whole
        // configuration. Verified 2026-09-09.
        return this.configuration.apiUrl || 'https://inference.do-ai.run/v1';
      case LlmProviderType.RUNPOD: {
        // RunPod always carries an endpoint in the path. For the public
        // catalog that is a shared model slug and no deployment is needed;
        // for a private serverless worker it is the customer's endpoint id.
        // There is no shared base without one. Verified 2026-09-09.
        const endpointId = this.configuration.runpod?.endpointId ?? '';
        return this.configuration.apiUrl || `https://api.runpod.ai/v2/${endpointId}/openai/v1`;
      }
      case LlmProviderType.MODAL:
        // Modal Endpoints. One shared base for the whole workspace; the
        // `model` field is the endpoint's hostname, and the model list is
        // scoped to what the proxy token can reach, so a Shared Endpoint
        // must exist before a call succeeds. Verified 2026-09-09.
        return this.configuration.apiUrl || 'https://inference.us-west.modal.direct/v1';
      case LlmProviderType.COHERE:
        // Cohere's OpenAI-compatible Compatibility API. The native /v2/chat
        // surface is NOT OpenAI-shaped (its own SSE event types, a
        // structured content array instead of a message string), so chat
        // rides /compatibility/v1 instead; the model list stays on the
        // documented native /v1/models (see getModelsUrl). Verified
        // 2026-09-09.
        return this.configuration.apiUrl || 'https://api.cohere.ai/compatibility/v1';
      case LlmProviderType.AZURE_OPENAI: {
        // The v1 data-plane surface: chat at <base>/chat/completions, model
        // list at <base>/models, no api-version query parameter, and an API
        // key accepted in either the `api-key` or the `Authorization`
        // header. The older dated surface put the deployment in the path
        // AND a query string on the base, so the shared OpenAI client built
        // ".../deployments/<name>?api-version=<v>/chat/completions" - a
        // malformed URL that could never have answered. The deployment name
        // is the `model` on this surface (see DefaultModelResolver).
        // Verified 2026-09-09. A configured apiUrl wins.
        const resourceName = this.configuration.azure?.resourceName;
        return this.configuration.apiUrl || `https://${resourceName}.openai.azure.com/openai/v1`;
      }
      case LlmProviderType.AWS_BEDROCK: {
        // Bedrock's OpenAI-compatible surface on the runtime host: chat at
        // <base>/chat/completions, model list at <base>/models, both
        // authenticated with a Bedrock API key as a plain bearer token (no
        // SigV4). Verified 2026-09-09, see docs/design/call-only-vendors.md.
        // A configured apiUrl wins, e.g. to target bedrock-mantle.
        const region = this.configuration.bedrock?.region || 'us-east-1';
        return this.configuration.apiUrl || `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`;
      }
      case LlmProviderType.HUGGINGFACE:
        // Inference Providers router: OpenAI-compatible chat at
        // <base>/chat/completions and a model list at <base>/models,
        // authenticated with a fine-grained hf_ token. The old
        // api-inference.huggingface.co host no longer resolves in DNS
        // (checked 2026-09-09), so it is not kept as a fallback.
        // `huggingface.endpoint` still points a provider at a dedicated
        // Inference Endpoint; apiUrl overrides anything else.
        return this.configuration.huggingface?.endpoint
          || this.configuration.apiUrl
          || 'https://router.huggingface.co/v1';
      case LlmProviderType.OLLAMA: {
        // OpenAI-compatible surface lives under /v1 on the Ollama server
        // root; `apiUrl` is the root (default: a local install). On
        // hosted almyty the URL must be publicly reachable — private and
        // loopback ranges are refused by the SSRF gate unless the
        // self-hosting escape hatch OLLAMA_ALLOW_PRIVATE_URLS=true is set.
        const ollamaBase = (this.configuration.apiUrl || 'http://localhost:11434').replace(/\/+$/, '');
        return ollamaBase.toLowerCase().endsWith('/v1') ? ollamaBase : `${ollamaBase}/v1`;
      }
      case LlmProviderType.CUSTOM:
        return this.configuration.apiUrl || '';
      default:
        return this.configuration.apiUrl || '';
    }
  }

  /**
   * Where the OpenAI-shaped model list lives. Almost every vendor serves it
   * at `<chat base>/models`, but two do not, and deriving the URL from the
   * chat base silently 404s there:
   *
   *  - DeepInfra documents the OpenAI-shaped listing at
   *    `https://api.deepinfra.com/v1/models`, one segment above its chat
   *    base `https://api.deepinfra.com/v1/openai`.
   *  - Cohere chats on `/compatibility/v1` but documents the listing only
   *    on the native `https://api.cohere.com/v1/models`.
   *
   * A configured apiUrl means the operator is pointing at their own proxy,
   * so the override steps aside and `<base>/models` applies again.
   *
   * Vendors with NO documented listing at all (Z.ai, SambaNova, Fireworks'
   * OpenAI surface) are not special-cased: the request is attempted, and a
   * failure surfaces as NO_MODEL_CONFIGURED rather than a guessed model id.
   */
  getModelsUrl(): string {
    const base = this.getApiUrl().replace(/\/+$/, '');
    if (!this.configuration?.apiUrl) {
      if (this.type === LlmProviderType.DEEPINFRA) return 'https://api.deepinfra.com/v1/models';
      if (this.type === LlmProviderType.COHERE) return 'https://api.cohere.com/v1/models';
    }
    return `${base}/models`;
  }

  /**
   * The Ollama server root (no /v1 suffix) for the native endpoints —
   * GET /api/tags (models) and POST /api/embed (embeddings).
   */
  getOllamaBaseUrl(): string {
    const base = (this.configuration?.apiUrl || 'http://localhost:11434').replace(/\/+$/, '');
    return base.toLowerCase().endsWith('/v1')
      ? base.slice(0, -3).replace(/\/+$/, '')
      : base;
  }

  /**
   * Encrypt the API key before it's persisted, using the org's envelope path so
   * a BYO-KMS org gets `encrypted:kms:` and every other org gets the SAME
   * platform `encrypted:gcm:` value as `encryptSensitiveData()` produces.
   * Call from the service layer right before save() (idempotent — already
   * encrypted values are left alone).
   */
  async encryptSensitiveDataForOrg(envelope: {
    encryptForOrg(orgId: string, plaintext: string): Promise<string>;
  }): Promise<void> {
    const key = this.configuration?.apiKey;
    if (typeof key === 'string' && key.length > 0 && !isEncrypted(key)) {
      this.configuration.apiKey = await envelope.encryptForOrg(
        this.organizationId,
        key,
      );
    }
    const usageKey = this.configuration?.usageApiKey;
    if (
      typeof usageKey === 'string' &&
      usageKey.length > 0 &&
      !isEncrypted(usageKey)
    ) {
      this.configuration.usageApiKey = await envelope.encryptForOrg(
        this.organizationId,
        usageKey,
      );
    }
  }

  /**
   * Encrypt the API key before it's persisted (platform path only). Retained
   * for callers that have no org/envelope context; the org-aware BYO-KMS path
   * is `encryptSensitiveDataForOrg()`. Idempotent — already-encrypted values
   * are left alone. Mirrors Credential.encryptSensitiveData().
   */
  encryptSensitiveData(): void {
    const key = this.configuration?.apiKey;
    if (typeof key === 'string' && key.length > 0 && !isEncrypted(key)) {
      this.configuration.apiKey = encryptField(key);
    }
    const usageKey = this.configuration?.usageApiKey;
    if (typeof usageKey === 'string' && usageKey.length > 0 && !isEncrypted(usageKey)) {
      this.configuration.usageApiKey = encryptField(usageKey);
    }
  }

  /**
   * The plaintext admin/usage API key (P7), or undefined if none is set.
   * Read through `usageCredential` when the provider references one; the
   * inline `configuration.usageApiKey` is the read-through shim for rows
   * the startup backfill has not moved yet.
   */
  getDecryptedUsageApiKey(): string | undefined {
    const fromRef = LlmProvider.secretFromCredential(this.usageCredential, ['apiKey', 'usageApiKey', 'token', 'key']);
    if (fromRef !== undefined) return fromRef;
    if (this.usageCredentialId) return undefined;
    const key = this.configuration?.usageApiKey;
    if (typeof key !== 'string' || key.length === 0) return undefined;
    return decryptField(key, this.organizationId);
  }

  /**
   * The plaintext API key for use in an outbound request. Read through
   * the referenced credential when `credentialId` is set (the relation
   * is eager, so it is loaded with the provider); otherwise the inline
   * `configuration.apiKey` shim, transparently decrypted. A
   * customer-managed (`encrypted:kms:`) value is unwrapped via the
   * registered envelope hook, so the org's DEK must be warmed first (the
   * service layer does this before invoking read paths). Every read site
   * must go through this, never configuration.apiKey directly.
   */
  getDecryptedApiKey(): string | undefined {
    const fromRef = LlmProvider.secretFromCredential(this.credential, ['apiKey', 'token', 'key', 'bearer']);
    if (fromRef !== undefined) return fromRef;
    if (this.credentialId) return undefined;
    const key = this.configuration?.apiKey;
    if (typeof key !== 'string' || key.length === 0) return undefined;
    return decryptField(key, this.organizationId);
  }

  getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const apiKey = this.getDecryptedApiKey();

    switch (this.type) {
      case LlmProviderType.OPENAI:
      case LlmProviderType.MISTRAL:
      case LlmProviderType.XAI:
      case LlmProviderType.DEEPSEEK:
      case LlmProviderType.GROQ:
      case LlmProviderType.TOGETHER:
      case LlmProviderType.COHERE:
      case LlmProviderType.HUGGINGFACE:
      // OpenAI-compatible inference hosts: plain Bearer key, same as OpenAI.
      case LlmProviderType.FIREWORKS:
      case LlmProviderType.CEREBRAS:
      case LlmProviderType.DEEPINFRA:
      case LlmProviderType.NOVITA:
      case LlmProviderType.PERPLEXITY:
      case LlmProviderType.ZAI:
      case LlmProviderType.BASETEN:
      case LlmProviderType.NEBIUS:
      case LlmProviderType.SAMBANOVA:
      // First-party model families, plain Bearer.
      case LlmProviderType.MOONSHOT:
      case LlmProviderType.QWEN:
      case LlmProviderType.MINIMAX:
      case LlmProviderType.UPSTAGE:
      case LlmProviderType.WRITER:
      case LlmProviderType.QIANFAN:
      case LlmProviderType.HUNYUAN:
      case LlmProviderType.VOLCENGINE:
      case LlmProviderType.SPARK:
      // Cloud and vendor serverless surfaces that take a static token as a
      // bearer: Foundry accepts the resource key in Authorization (which is
      // what makes it drop-in OpenAI-compatible), DigitalOcean a model
      // access key, RunPod an rpa_ key, Modal a workspace proxy token.
      case LlmProviderType.AZURE_AI_FOUNDRY:
      case LlmProviderType.DIGITALOCEAN:
      case LlmProviderType.RUNPOD:
      case LlmProviderType.MODAL:
      // Bedrock's OpenAI-compatible surface takes a Bedrock API key as a
      // plain bearer token; SigV4 signing is not needed on this path.
      case LlmProviderType.AWS_BEDROCK:
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        break;

      case LlmProviderType.VERTEX_AI:
        // Deliberately empty. Vertex authenticates with a one-hour OAuth
        // access token minted from a service-account key, which cannot be
        // produced synchronously; vertex.provider.ts mints it and supplies
        // the headers. Emitting the stored credential as a bearer here
        // would put a private key on the wire.
        break;

      case LlmProviderType.AZURE_OPENAI:
        // An Azure OpenAI API key goes in the `api-key` header. Sending it
        // as `Authorization: Bearer` is wrong on the dated deployments
        // surface (Bearer there means a Microsoft Entra ID token, so a key
        // sent that way 401s) and merely one of several accepted schemes on
        // the /openai/v1 surface. `api-key` is correct on both. Verified
        // 2026-09-09.
        if (apiKey) {
          headers['api-key'] = apiKey;
        }
        break;

      case LlmProviderType.OPENROUTER:
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
          // App attribution. X-OpenRouter-Title superseded X-Title, which
          // is still accepted for backwards compatibility (2026-09-09).
          headers['HTTP-Referer'] = 'https://almyty.com';
          headers['X-OpenRouter-Title'] = 'almyty';
        }
        break;

      case LlmProviderType.OLLAMA:
        // Ollama itself is unauthenticated — no API key is required.
        // A key is optional and only sent (as a Bearer token) when
        // configured, for deployments that front Ollama with an
        // authenticating reverse proxy.
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        break;

      case LlmProviderType.ANTHROPIC:
        if (apiKey) {
          headers['x-api-key'] = apiKey;
          headers['anthropic-version'] = this.configuration.apiVersion || '2023-06-01';
        }
        break;

      case LlmProviderType.GOOGLE:
        // The documented way to authenticate the Gemini API is the
        // x-goog-api-key header. The ?key= query parameter still works but
        // Google's own guidance calls it out as leaking the key through URL
        // scans and logs, so the header is what we send. Verified
        // 2026-09-09.
        if (apiKey) {
          headers['x-goog-api-key'] = apiKey;
        }
        break;

      case LlmProviderType.CUSTOM:
        if (this.configuration.custom?.headers) {
          // Tenant-supplied — strip hop-by-hop/forwarding headers and any
          // CRLF-injection values before they reach the upstream request,
          // the same guard the HTTP/gRPC tool executors already apply.
          Object.assign(headers, sanitizeHeaders(this.configuration.custom.headers));
        }
        if (this.configuration.custom?.authMethod === 'bearer' && apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        } else if (this.configuration.custom?.authMethod === 'api_key' && apiKey) {
          headers['X-API-Key'] = apiKey;
        }
        break;
    }

    headers['User-Agent'] = 'almyty/1.0';
    headers['Content-Type'] = 'application/json';

    return headers;
  }

  /**
   * The API view: secret values replaced by a marker, the backing
   * credential rows reduced to a reference (id, name, connector, health)
   * so the dashboard can show which connection a provider uses without
   * ever seeing its config.
   */
  maskSensitiveData(): Partial<LlmProvider> & LlmProviderCredentialRefs {
    const { credential, usageCredential, ...rest } = this;
    const masked: Partial<LlmProvider> & LlmProviderCredentialRefs = { ...rest };

    // Mask sensitive configuration data
    if (masked.configuration) {
      masked.configuration = {
        ...masked.configuration,
        apiKey: this.hasInferenceKey() ? '***masked***' : undefined,
        usageApiKey: this.hasUsageKey() ? '***masked***' : undefined,
        azure: masked.configuration.azure ? {
          ...masked.configuration.azure,
        } : undefined,
        bedrock: masked.configuration.bedrock ? {
          ...masked.configuration.bedrock,
          accessKeyId: masked.configuration.bedrock.accessKeyId ? '***masked***' : undefined,
          secretAccessKey: masked.configuration.bedrock.secretAccessKey ? '***masked***' : undefined,
          sessionToken: masked.configuration.bedrock.sessionToken ? '***masked***' : undefined,
        } : undefined,
      };
    }

    masked.credentialRef = LlmProvider.refOf(this.credentialId, credential);
    masked.usageCredentialRef = LlmProvider.refOf(this.usageCredentialId, usageCredential);

    return masked;
  }

  /** True when an inference key exists, on the credential or (shim) inline. */
  hasInferenceKey(): boolean {
    return !!this.credentialId || !!this.configuration?.apiKey;
  }

  /** True when a usage/admin key exists, on the credential or (shim) inline. */
  hasUsageKey(): boolean {
    return !!this.usageCredentialId || !!this.configuration?.usageApiKey;
  }

  private static refOf(id: string | null | undefined, row: Credential | null | undefined): LlmProviderCredentialRef | null {
    if (!id) return null;
    return {
      id,
      name: row?.name ?? null,
      connectorKey: row?.connectorKey ?? null,
      healthStatus: row?.healthStatus ?? null,
    };
  }

  /**
   * Read one secret field off a loaded credential relation. Sync by
   * design: the relation is eager, so every repository read carries the
   * row, and the org's KMS envelope is warmed by the same service-layer
   * step that already precedes every sync key read.
   */
  private static secretFromCredential(row: Credential | null | undefined, fields: string[]): string | undefined {
    if (!row || typeof (row as any).getDecryptedConfig !== 'function') return undefined;
    if (row.isActive === false) return undefined;
    const config = row.getDecryptedConfig();
    for (const field of fields) {
      const value = config?.[field];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return undefined;
  }

  calculateEstimatedCost(inputTokens: number, outputTokens: number): number {
    const modelInfo = this.metadata?.modelInfo;
    if (!modelInfo?.inputTokenCost || !modelInfo?.outputTokenCost) {
      return 0;
    }

    const inputCost = (inputTokens / 1000) * modelInfo.inputTokenCost;
    const outputCost = (outputTokens / 1000) * modelInfo.outputTokenCost;
    
    return inputCost + outputCost;
  }

  toPublicView(): Partial<LlmProvider> & LlmProviderCredentialRefs {
    const {
      configuration,
      ...publicData
    } = this.maskSensitiveData();

    return {
      ...publicData,
      configuration: {
        model: configuration?.model,
        maxTokens: configuration?.maxTokens,
        temperature: configuration?.temperature,
        timeout: configuration?.timeout,
        retries: configuration?.retries,
        // The server URL is public (ollama, custom); the edit form prefills it.
        apiUrl: configuration?.apiUrl,
      },
    };
  }
}