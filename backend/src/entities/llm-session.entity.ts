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
import { LlmProvider } from './llm-provider.entity';
import { Gateway } from './gateway.entity';
import { User } from './user.entity';
import { Organization } from './organization.entity';
import { LlmMessage } from './llm-message.entity';

export enum SessionStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed',
  TIMEOUT = 'timeout',
  CANCELLED = 'cancelled',
}

export enum SessionType {
  CHAT = 'chat',
  COMPLETION = 'completion',
  TOOL_USE = 'tool_use',
  FUNCTION_CALLING = 'function_calling',
  BATCH = 'batch',
  STREAMING = 'streaming',
}

@Entity('llm_sessions')
@Index(['providerId', 'status'])
@Index(['gatewayId', 'status'])
@Index(['organizationId', 'createdAt'])
@Index(['userId', 'createdAt'])
export class LlmSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  externalSessionId: string; // Session ID from the LLM provider

  @Column()
  providerId: string;

  @Column({ nullable: true })
  gatewayId: string;

  @Column({ nullable: true })
  userId: string;

  @Column()
  organizationId: string;

  @Column({
    type: 'varchar',
    default: SessionType.CHAT,
  })
  type: SessionType;

  @Column({
    type: 'varchar',
    default: SessionStatus.ACTIVE,
  })
  status: SessionStatus;

  @Column({ nullable: true })
  title: string; // Optional session title

  @Column({ type: 'json', nullable: true })
  context: {
    model?: string;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stopSequences?: string[];
    toolsEnabled?: boolean;
    availableTools?: string[]; // Tool IDs available in this session
  };

  @Column({ default: 0 })
  messageCount: number;

  @Column({ default: 0 })
  totalInputTokens: number;

  @Column({ default: 0 })
  totalOutputTokens: number;

  @Column({ type: 'float', default: 0 })
  totalCost: number; // in cents

  @Column({ default: 0 })
  toolCalls: number;

  @Column({ default: 0 })
  successfulToolCalls: number;

  @Column({ nullable: true })
  lastActivityAt: Date;

  @Column({ nullable: true })
  completedAt: Date;

  @Column({ nullable: true })
  failureReason: string;

  @Column({ type: 'json', nullable: true })
  metadata: {
    userAgent?: string;
    clientIp?: string;
    referrer?: string;
    sessionDuration?: number; // in milliseconds
    averageResponseTime?: number;
    errorCount?: number;
    retryCount?: number;
    requestCount?: number;
    streamingUsed?: boolean;
    batchSize?: number;
  };

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => LlmProvider, provider => provider.sessions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'providerId' })
  provider: LlmProvider;

  @ManyToOne(() => Gateway, gateway => gateway.llmSessions, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'gatewayId' })
  gateway: Gateway;

  @ManyToOne(() => User, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'userId' })
  user: User;

  @ManyToOne(() => Organization, org => org.llmSessions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @OneToMany(() => LlmMessage, message => message.session, {
    cascade: true,
  })
  messages: LlmMessage[];

  // Methods
  isActive(): boolean {
    return this.status === SessionStatus.ACTIVE;
  }

  isCompleted(): boolean {
    return [
      SessionStatus.COMPLETED,
      SessionStatus.FAILED,
      SessionStatus.TIMEOUT,
      SessionStatus.CANCELLED,
    ].includes(this.status);
  }

  getTotalTokens(): number {
    return this.totalInputTokens + this.totalOutputTokens;
  }

  getAverageCostPerMessage(): number {
    if (this.messageCount === 0) return 0;
    return this.totalCost / this.messageCount;
  }

  getAverageTokensPerMessage(): number {
    if (this.messageCount === 0) return 0;
    return this.getTotalTokens() / this.messageCount;
  }

  getToolCallSuccessRate(): number {
    if (this.toolCalls === 0) return 0;
    return (this.successfulToolCalls / this.toolCalls) * 100;
  }

  getSessionDuration(): number {
    const endTime = this.completedAt || new Date();
    return endTime.getTime() - this.createdAt.getTime();
  }

  getAverageResponseTime(): number {
    return this.metadata?.averageResponseTime || 0;
  }

  addMessage(inputTokens: number, outputTokens: number, cost: number): void {
    this.messageCount++;
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCost += cost;
    this.lastActivityAt = new Date();
  }

  addToolCall(successful: boolean = true): void {
    this.toolCalls++;
    if (successful) {
      this.successfulToolCalls++;
    }
  }

  updateStatus(status: SessionStatus, reason?: string): void {
    this.status = status;
    
    if (this.isCompleted()) {
      this.completedAt = new Date();
      if (reason) {
        this.failureReason = reason;
      }
      
      // Update session duration in metadata
      this.metadata = {
        ...this.metadata,
        sessionDuration: this.getSessionDuration(),
      };
    }
  }

  updateMetadata(updates: Partial<LlmSession['metadata']>): void {
    this.metadata = {
      ...this.metadata,
      ...updates,
    };
  }

  calculateAverageResponseTime(): number {
    if (!this.messages || this.messages.length === 0) return 0;
    
    const responseTimes = this.messages
      .filter(msg => msg.responseTime !== null && msg.responseTime !== undefined)
      .map(msg => msg.responseTime);
    
    if (responseTimes.length === 0) return 0;
    
    const total = responseTimes.reduce((sum, time) => sum + time, 0);
    const average = total / responseTimes.length;
    
    // Update metadata
    this.updateMetadata({ averageResponseTime: Math.round(average) });
    
    return average;
  }

  hasToolsEnabled(): boolean {
    return this.context?.toolsEnabled === true;
  }

  getAvailableTools(): string[] {
    return this.context?.availableTools || [];
  }

  addAvailableTool(toolId: string): void {
    const currentTools = this.getAvailableTools();
    if (!currentTools.includes(toolId)) {
      this.context = {
        ...this.context,
        availableTools: [...currentTools, toolId],
      };
    }
  }

  removeAvailableTool(toolId: string): void {
    const currentTools = this.getAvailableTools();
    this.context = {
      ...this.context,
      availableTools: currentTools.filter(id => id !== toolId),
    };
  }

  toSummary(): {
    id: string;
    title: string;
    type: SessionType;
    status: SessionStatus;
    messageCount: number;
    totalTokens: number;
    totalCost: number;
    toolCalls: number;
    duration: number;
    createdAt: Date;
    completedAt?: Date;
    lastActivityAt?: Date;
  } {
    return {
      id: this.id,
      title: this.title || `Session ${this.id.slice(0, 8)}`,
      type: this.type,
      status: this.status,
      messageCount: this.messageCount,
      totalTokens: this.getTotalTokens(),
      totalCost: this.totalCost,
      toolCalls: this.toolCalls,
      duration: this.getSessionDuration(),
      createdAt: this.createdAt,
      completedAt: this.completedAt,
      lastActivityAt: this.lastActivityAt,
    };
  }

  static createSession(data: {
    providerId: string;
    organizationId: string;
    gatewayId?: string;
    userId?: string;
    type?: SessionType;
    title?: string;
    context?: LlmSession['context'];
    metadata?: LlmSession['metadata'];
  }): LlmSession {
    const session = new LlmSession();
    session.providerId = data.providerId;
    session.organizationId = data.organizationId;
    session.gatewayId = data.gatewayId;
    session.userId = data.userId;
    session.type = data.type || SessionType.CHAT;
    session.title = data.title;
    session.context = data.context || {};
    session.metadata = data.metadata || {};
    session.status = SessionStatus.ACTIVE;
    session.lastActivityAt = new Date();
    
    return session;
  }

  // Cost tracking helpers
  addInputTokens(count: number, costPerToken?: number): void {
    this.totalInputTokens += count;
    if (costPerToken) {
      this.totalCost += count * costPerToken;
    }
  }

  addOutputTokens(count: number, costPerToken?: number): void {
    this.totalOutputTokens += count;
    if (costPerToken) {
      this.totalCost += count * costPerToken;
    }
  }

  estimateRemainingBudget(budgetLimit: number): {
    remaining: number;
    percentage: number;
    canContinue: boolean;
  } {
    const remaining = Math.max(0, budgetLimit - this.totalCost);
    const percentage = budgetLimit > 0 ? (remaining / budgetLimit) * 100 : 0;
    const canContinue = remaining > 0;

    return {
      remaining: Math.round(remaining * 100) / 100, // Round to 2 decimal places
      percentage: Math.round(percentage * 100) / 100,
      canContinue,
    };
  }
}