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
import { Organization } from './organization.entity';
import { AgentExecution } from './agent-execution.entity';
import { AgentRun } from './agent-run.entity';
import { AgentMode } from './agent-run.entity';

export { AgentMode };

export enum AgentStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
}

export interface AgentPipelineNode {
  id: string;
  type: string;
  label?: string;
  data?: Record<string, any>;    // React Flow convention (frontend)
  config?: Record<string, any>;  // Backend convention
  position?: { x: number; y: number };
}

export interface AgentPipelineEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string; // 'true' | 'false' for condition nodes
  label?: string;
  condition?: string;
}

export interface AgentPipeline {
  nodes: AgentPipelineNode[];
  edges: AgentPipelineEdge[];
}

@Entity('agents')
@Index(['organizationId', 'name'])
@Index(['organizationId', 'status'])
export class Agent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column()
  organizationId: string;

  @Column({
    type: 'varchar',
    default: AgentStatus.DRAFT,
  })
  status: AgentStatus;

  @Column({ default: '1.0.0' })
  version: string;

  @Column({ type: 'json' })
  pipeline: AgentPipeline;

  @Column({ type: 'json', nullable: true })
  variables: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  settings: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @Column({ type: 'varchar', default: 'workflow' })
  mode: 'workflow' | 'autonomous';

  @Column({ type: 'text', nullable: true })
  instructions: string;

  @Column({ type: 'uuid', array: true, default: '{}' })
  toolIds: string[];

  @Column({ type: 'json', nullable: true })
  modelConfig: {
    providerId?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };

  @Column({ type: 'json', nullable: true })
  memoryConfig: {
    enabled?: boolean;
    autoSave?: boolean;
    scopes?: string[];
  };

  @Column({ type: 'varchar', nullable: true })
  webhookUrl: string;

  @Column({ default: 0 })
  totalExecutions: number;

  @Column({ default: 0 })
  successfulExecutions: number;

  @Column({ type: 'float', default: 0 })
  totalCost: number;

  @Column({ default: 0 })
  averageExecutionTime: number;

  @Column({ nullable: true })
  lastExecutedAt: Date;

  @Column({ nullable: true })
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @OneToMany(() => AgentExecution, exec => exec.agent, {
    cascade: true,
  })
  executions: AgentExecution[];

  @OneToMany(() => AgentRun, run => run.agent, { cascade: true })
  runs: AgentRun[];

  // Methods
  isActive(): boolean {
    return this.status === AgentStatus.ACTIVE;
  }

  getSuccessRate(): number {
    if (this.totalExecutions === 0) return 0;
    return (this.successfulExecutions / this.totalExecutions) * 100;
  }

  incrementExecution(success: boolean, executionTime: number, cost: number) {
    this.totalExecutions++;
    if (success) {
      this.successfulExecutions++;
    }
    this.totalCost += cost;
    // Running average
    this.averageExecutionTime = Math.round(
      ((this.averageExecutionTime * (this.totalExecutions - 1)) + executionTime) / this.totalExecutions,
    );
    this.lastExecutedAt = new Date();
  }
}
