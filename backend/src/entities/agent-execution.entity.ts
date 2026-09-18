import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Agent } from './agent.entity';
import { Organization } from './organization.entity';

export enum AgentExecutionStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  TIMEOUT = 'timeout',
}

@Entity('agent_executions')
@Index(['agentId', 'createdAt'])
@Index(['organizationId', 'createdAt'])
export class AgentExecution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  agentId: string;

  @Column()
  organizationId: string;

  @Column({ nullable: true })
  userId: string;

  @Column({
    type: 'varchar',
    default: AgentExecutionStatus.PENDING,
  })
  status: AgentExecutionStatus;

  @Column({ type: 'json', nullable: true })
  input: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  output: any;

  @Column({ type: 'json', nullable: true })
  nodeResults: Record<string, any>;

  @Column({ default: 0 })
  executionTime: number;

  @Column({ type: 'float', default: 0 })
  totalCost: number;

  @Column({ default: 0 })
  totalTokens: number;

  /**
   * The prompt/completion split of totalTokens, summed over the run's llm
   * nodes. Recorded because the OpenAI-compatible route has to answer with
   * prompt_tokens/completion_tokens and had nothing but zeros to give:
   * providers return the split and every layer above discarded it. Nodes
   * without a split (tool, transform) contribute to totalTokens only, so
   * these two sum to at most totalTokens rather than exactly to it.
   */
  @Column({ default: 0 })
  inputTokens: number;

  @Column({ default: 0 })
  outputTokens: number;

  @Column({ type: 'text', nullable: true })
  error: string;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Agent, agent => agent.executions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'agentId' })
  agent: Agent;

  @ManyToOne(() => Organization, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  // Helper methods
  getDurationInSeconds(): number {
    return Math.round(this.executionTime / 1000);
  }

  isSuccessful(): boolean {
    return this.status === AgentExecutionStatus.COMPLETED;
  }

  isFailed(): boolean {
    return this.status === AgentExecutionStatus.FAILED;
  }

  isRunning(): boolean {
    return this.status === AgentExecutionStatus.RUNNING;
  }
}
