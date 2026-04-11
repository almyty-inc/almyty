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
import { Agent } from './agent.entity';
import { Message } from './message.entity';

export enum ConversationStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

@Entity('conversations')
@Index(['providerId', 'status'])
@Index(['gatewayId', 'status'])
@Index(['organizationId', 'createdAt'])
@Index(['userId', 'createdAt'])
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  externalSessionId: string;

  @Column({ nullable: true })
  providerId: string;

  @Column({ nullable: true })
  agentId: string;

  @Column({ nullable: true })
  externalAgentId: string;

  @Column({ nullable: true })
  parentConversationId: string;

  @Column({ nullable: true })
  gatewayId: string;

  @Column({ nullable: true })
  userId: string;

  @Column()
  organizationId: string;

  @Column({
    type: 'varchar',
    default: ConversationStatus.ACTIVE,
  })
  status: ConversationStatus;

  @Column({ nullable: true })
  title: string;

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
    availableTools?: string[];
  };

  @Column({ default: 0 })
  messageCount: number;

  @Column({ default: 0 })
  totalInputTokens: number;

  @Column({ default: 0 })
  totalOutputTokens: number;

  @Column({ type: 'float', default: 0 })
  totalCost: number;

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
    sessionDuration?: number;
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
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'providerId' })
  provider: LlmProvider;

  @ManyToOne(() => Agent, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'agentId' })
  agent: Agent;

  @ManyToOne(() => Conversation, conversation => conversation.children, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'parentConversationId' })
  parent: Conversation;

  @OneToMany(() => Conversation, conversation => conversation.parent)
  children: Conversation[];

  @ManyToOne(() => Gateway, gateway => gateway.conversations, {
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

  @ManyToOne(() => Organization, org => org.conversations, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @OneToMany(() => Message, message => message.conversation, {
    cascade: true,
  })
  messages: Message[];

  // Methods
  isActive(): boolean {
    return this.status === ConversationStatus.ACTIVE;
  }

  isCompleted(): boolean {
    return [
      ConversationStatus.FAILED,
      ConversationStatus.CANCELLED,
      ConversationStatus.ARCHIVED,
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

  updateStatus(status: ConversationStatus, reason?: string): void {
    this.status = status;

    if (this.isCompleted()) {
      this.completedAt = new Date();
      if (reason) {
        this.failureReason = reason;
      }

      this.metadata = {
        ...this.metadata,
        sessionDuration: this.getSessionDuration(),
      };
    }
  }

  updateMetadata(updates: Partial<Conversation['metadata']>): void {
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
    status: ConversationStatus;
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
      title: this.title || `Conversation ${this.id.slice(0, 8)}`,
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

  static createConversation(data: {
    providerId?: string;
    agentId?: string;
    externalAgentId?: string;
    organizationId: string;
    gatewayId?: string;
    userId?: string;
    title?: string;
    context?: Conversation['context'];
    metadata?: Conversation['metadata'];
  }): Conversation {
    const conversation = new Conversation();
    conversation.providerId = data.providerId;
    conversation.agentId = data.agentId;
    conversation.externalAgentId = data.externalAgentId;
    conversation.organizationId = data.organizationId;
    conversation.gatewayId = data.gatewayId;
    conversation.userId = data.userId;
    conversation.title = data.title;
    conversation.context = data.context || {};
    conversation.metadata = data.metadata || {};
    conversation.status = ConversationStatus.ACTIVE;
    conversation.lastActivityAt = new Date();

    return conversation;
  }

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
      remaining: Math.round(remaining * 100) / 100,
      percentage: Math.round(percentage * 100) / 100,
      canContinue,
    };
  }
}
