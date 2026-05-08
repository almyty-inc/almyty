import {
  Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Agent } from './agent.entity';
import { Organization } from './organization.entity';
import { Conversation } from './conversation.entity';

export enum AgentRunStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  WAITING_INPUT = 'waiting_input',
  SLEEPING = 'sleeping',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  TIMEOUT = 'timeout',
  /** Run paused on a HITL approval gate. Resumes on approve, terminates on reject. */
  WAITING_APPROVAL = 'waiting_approval',
}

export enum AgentMode {
  WORKFLOW = 'workflow',
  AUTONOMOUS = 'autonomous',
}

@Entity('agent_runs')
@Index(['agentId', 'createdAt'])
@Index(['organizationId', 'createdAt'])
@Index(['status'])
export class AgentRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  agentId: string;

  @Column()
  organizationId: string;

  @Column({ nullable: true })
  userId: string;

  @Column({ nullable: true })
  conversationId: string;

  @Column({ type: 'varchar', default: AgentMode.WORKFLOW })
  mode: AgentMode;

  @Column({ type: 'varchar', default: AgentRunStatus.PENDING })
  status: AgentRunStatus;

  @Column({ type: 'json', default: {} })
  workingMemory: Record<string, any>;

  @Column({ type: 'json', default: [] })
  steps: Array<{
    type: string;
    input?: any;
    output?: any;
    cost?: number;
    tokens?: { input: number; output: number };
    duration?: number;
    timestamp: string;
    error?: string;
  }>;

  @Column({ default: 0 })
  currentStep: number;

  @Column({ default: 50 })
  maxSteps: number;

  @Column({ type: 'json', nullable: true })
  input: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  output: any;

  @Column({ type: 'text', nullable: true })
  error: string;

  @Column({ type: 'float', default: 0 })
  totalCost: number;

  @Column({ default: 0 })
  totalTokens: number;

  @Column({ default: 0 })
  executionTime: number;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  limits: {
    maxSteps?: number;
    maxDurationMs?: number;
    maxCostCents?: number;
    maxTokens?: number;
    maxToolCalls?: number;
  };

  @Column({ nullable: true })
  parentRunId: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Agent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agentId' })
  agent: Agent;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @ManyToOne(() => Conversation, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  // Helper methods
  isRunning(): boolean {
    return this.status === AgentRunStatus.RUNNING;
  }

  isCompleted(): boolean {
    return this.status === AgentRunStatus.COMPLETED;
  }

  isDone(): boolean {
    return [AgentRunStatus.COMPLETED, AgentRunStatus.FAILED, AgentRunStatus.CANCELLED, AgentRunStatus.TIMEOUT].includes(this.status);
  }

  getDurationInSeconds(): number {
    return Math.round(this.executionTime / 1000);
  }
}
