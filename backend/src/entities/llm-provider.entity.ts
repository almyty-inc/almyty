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
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };
  huggingface?: {
    endpoint?: string;
    taskType?: string;
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
        return this.configuration.apiUrl || 'https://api.deepseek.com/v1';
      case LlmProviderType.GROQ:
        return this.configuration.apiUrl || 'https://api.groq.com/openai/v1';
      case LlmProviderType.TOGETHER:
        return this.configuration.apiUrl || 'https://api.together.xyz/v1';
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
        return this.configuration.apiUrl || 'https://api.novita.ai/openai';
      case LlmProviderType.PERPLEXITY:
        // Router API (OpenAI-compatible, lists models). The legacy Sonar
        // endpoint is https://api.perplexity.ai (no /models; retired
        // 2026-09-27 in favour of the non-OpenAI-shaped Agent API) and
        // can still be set as apiUrl with an explicit model.
        return this.configuration.apiUrl || 'https://api.perplexity.ai/router/v1';
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
      case LlmProviderType.COHERE:
        return this.configuration.apiUrl || 'https://api.cohere.ai/v2';
      case LlmProviderType.AZURE_OPENAI:
        const resourceName = this.configuration.azure?.resourceName;
        const apiVersion = this.configuration.azure?.apiVersion || '2024-10-21';
        return `https://${resourceName}.openai.azure.com/openai/deployments/${this.configuration.azure?.deploymentName}?api-version=${apiVersion}`;
      case LlmProviderType.AWS_BEDROCK:
        const region = this.configuration.bedrock?.region || 'us-east-1';
        return `https://bedrock-runtime.${region}.amazonaws.com`;
      case LlmProviderType.HUGGINGFACE:
        return this.configuration.huggingface?.endpoint || 'https://api-inference.huggingface.co/models';
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
      case LlmProviderType.AZURE_OPENAI:
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
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        break;

      case LlmProviderType.OPENROUTER:
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
          headers['HTTP-Referer'] = 'https://almyty.com';
          headers['X-Title'] = 'almyty';
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
        if (apiKey) {
          // Google uses query parameter for API key
          // headers will be handled differently in the service
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