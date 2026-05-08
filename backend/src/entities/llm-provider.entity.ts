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
  CUSTOM = 'custom',
}

export enum LlmProviderStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
  MAINTENANCE = 'maintenance',
}

export interface LlmProviderConfig {
  apiKey?: string;
  apiUrl?: string;
  apiVersion?: string;
  model?: string;
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

  @Column({ nullable: true })
  credentialId: string;

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

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, org => org.llmProviders, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @ManyToOne(() => Credential, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'credentialId' })
  credential: Credential;

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
        return this.configuration.apiUrl || 'https://generativelanguage.googleapis.com/v1';
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
      case LlmProviderType.CUSTOM:
        return this.configuration.apiUrl || '';
      default:
        return this.configuration.apiUrl || '';
    }
  }

  getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};

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
        if (this.configuration.apiKey) {
          headers['Authorization'] = `Bearer ${this.configuration.apiKey}`;
        }
        break;

      case LlmProviderType.OPENROUTER:
        if (this.configuration.apiKey) {
          headers['Authorization'] = `Bearer ${this.configuration.apiKey}`;
          headers['HTTP-Referer'] = 'https://almyty.com';
          headers['X-Title'] = 'almyty';
        }
        break;

      case LlmProviderType.ANTHROPIC:
        if (this.configuration.apiKey) {
          headers['x-api-key'] = this.configuration.apiKey;
          headers['anthropic-version'] = this.configuration.apiVersion || '2023-06-01';
        }
        break;

      case LlmProviderType.GOOGLE:
        if (this.configuration.apiKey) {
          // Google uses query parameter for API key
          // headers will be handled differently in the service
        }
        break;

      case LlmProviderType.CUSTOM:
        if (this.configuration.custom?.headers) {
          Object.assign(headers, this.configuration.custom.headers);
        }
        if (this.configuration.custom?.authMethod === 'bearer' && this.configuration.apiKey) {
          headers['Authorization'] = `Bearer ${this.configuration.apiKey}`;
        } else if (this.configuration.custom?.authMethod === 'api_key' && this.configuration.apiKey) {
          headers['X-API-Key'] = this.configuration.apiKey;
        }
        break;
    }

    headers['User-Agent'] = 'almyty/1.0';
    headers['Content-Type'] = 'application/json';

    return headers;
  }

  maskSensitiveData(): Partial<LlmProvider> {
    const masked = { ...this };
    
    // Mask sensitive configuration data
    if (masked.configuration) {
      masked.configuration = {
        ...masked.configuration,
        apiKey: masked.configuration.apiKey ? '***masked***' : undefined,
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

    return masked;
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

  toPublicView(): Partial<LlmProvider> {
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
      },
    };
  }
}