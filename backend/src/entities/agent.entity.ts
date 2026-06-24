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
@VersionedEntity()
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

  @Column({ type: 'text', nullable: true })
  personality: string;

  @Column({ type: 'json', nullable: true })
  heartbeat: {
    enabled: boolean;
    intervalMinutes: number;
    prompt: string;
  };

  @Column({ type: 'uuid', array: true, default: '{}' })
  toolIds: string[];

  @Column({ type: 'json', nullable: true })
  modelConfig: {
    providerId?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    /**
     * Context compaction for long autonomous runs (off unless enabled). When the
     * assembled context exceeds maxContextTokens, the old prefix is summarized
     * (or truncated) and folded into the system prompt while a recent tail is
     * kept verbatim. See AgentContextCompactor.
     */
    compaction?: {
      enabled?: boolean;
      maxContextTokens?: number;
      keepRecentMessages?: number;
      strategy?: 'summarize' | 'truncate';
      providerId?: string;
      model?: string;
    };
  };

  @Column({ type: 'json', nullable: true })
  memoryConfig: {
    enabled?: boolean;
    autoSave?: boolean;
    scopes?: string[];
  };

  @Column({ type: 'json', nullable: true })
  agentConfig: {
    canCallAgents?: boolean;
    canCreateAgents?: boolean;
    /**
     * Autonomous verify: a refute-only checker panel reviews the agent's final
     * answer. On failure (within the revision budget) the failures are fed back
     * as synthetic user feedback and the agent loops again. Checkers pick their
     * vendor per-checker via providerId (multi-vendor = different-vendor
     * provider entities). Mirrors the pipeline `verify` node's config.
     */
    verify?: {
      enabled?: boolean;
      checkers: Array<{
        name?: string;
        providerId: string;
        model?: string;
        instructions?: string;
        temperature?: number;
        maxTokens?: number;
      }>;
      policy?: 'all_pass' | 'majority' | 'any_fail_blocks';
      spec?: string;
      maxReviseLoops?: number;
    };
  };

  @Column({ default: false })
  isTemporary: boolean;

  @Column({ nullable: true })
  parentRunId: string;

  @Column({ type: 'json', nullable: true })
  collaboration: {
    strategy: 'sequential' | 'parallel' | 'race' | 'debate';
    agents: Array<{ agentId: string; role?: string }>;
    sharedBrief?: string;
    rules?: {
      maxTotalCost?: number;
      maxChainDepth?: number;
      outputFormat?: 'text' | 'json';
      escalation?: 'never' | 'on_failure' | 'on_low_confidence';
      conflictResolution?: 'judge' | 'majority' | 'first_wins' | 'merge';
      allowRevision?: boolean;
      sharedMemoryScope?: boolean;
    };
    judgeAgentId?: string;
    maxRounds?: number;
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
