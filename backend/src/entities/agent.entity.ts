import type { RoutingPolicy } from '../modules/model-catalog/routing/model-router';
import type { AgentCollaboration } from '../modules/agents/collaboration-participants';
import type { AgentModels } from '../modules/agents/autonomous-models';
import type { ChannelBranding, VisitorRules } from './agent-channel.entity';
import type { CodeModeConfig } from '../modules/code-mode/code-write-policy';
export type {
  AgentCollaboration,
  CollaborationParticipant,
} from '../modules/agents/collaboration-participants';
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

/**
 * Why the system switched an agent's schedule or heartbeat off on its own,
 * recorded on it (`settings.schedule.pausedReason`, `heartbeat.pausedReason`)
 * so the agent page can say what happened. Turning it back on clears it.
 *
 * - MODEL_NOT_FOUND: the vendor retired the configured model.
 * - OWNER_CANNOT_RUN: the owner, whom scheduled and heartbeat runs act as,
 *   can no longer run the agent (left its team, or it became private to
 *   someone else).
 * - OWNER_NOT_MEMBER: the owner is no longer an active member of the org.
 * - RESTORE_FAILED: the schedule could not be restored after a restart.
 */
export interface AgentPauseReason {
  code: 'MODEL_NOT_FOUND' | 'OWNER_CANNOT_RUN' | 'OWNER_NOT_MEMBER' | 'RESTORE_FAILED';
  message: string;
  detectedAt: string;
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
  visibility: 'org' | 'team' | 'private';

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
    /** Set when the system turned the heartbeat off on its own; see AgentPauseReason. */
    pausedReason?: AgentPauseReason;
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
     * Catalog routing for autonomous runs: when set, the run picks a model
     * per step from the org's cards instead of pinning providerId/model.
     * Verify escalation (routing.escalation) moves to the next candidate
     * when the verifier rejects an answer.
     */
    routing?: RoutingPolicy;
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

  /**
   * The Memory section of an autonomous agent: which account its memories
   * are kept in, whose memory it is, what gets saved (and what never is),
   * and how long it is kept. See AgentMemoryConfig in
   * modules/agents/agent-memory-settings.ts.
   */
  @Column({ type: 'json', nullable: true })
  memoryConfig: {
    enabled?: boolean;
    autoSave?: boolean;
    scopes?: string[];
    account?: string;
    whose?: 'person' | 'agent' | 'shared';
    save?: 'facts' | 'conversations' | 'asked';
    neverSave?: string;
    retentionDays?: number | null;
    credentialId?: string | null;
  };

  @Column({ type: 'json', nullable: true })
  agentConfig: {
    /** Kept equal to "callableAgentIds is not empty" (normaliseCapabilities). */
    canCallAgents?: boolean;
    /** The other agents it may call or hand work to (agent-capabilities.ts). */
    callableAgentIds?: string[];
    /** APIs it may use: every active tool of each, including tools added later. */
    apiIds?: string[];
    canCreateAgents?: boolean;
    /** Temporary agents it may create in one run. */
    maxTemporaryAgents?: number;
    /** Temporary agents of its runs that may exist at once. */
    maxTemporaryAgentsAlive?: number;
    /**
     * Label requirements for the machine the agent's runner-backed tools
     * run on (`{ gpu: 'yes' }`). Each such call goes to an online runner
     * the run's principal may use whose labels include all of them
     * (RunnerService.resolveByLabels). Absent: the tool's own runner.
     */
    runnerLabels?: Record<string, string>;
    /**
     * Who the agent's unattended runs act as (a schedule; Always on once it
     * lands): its owner (default), or the agent itself, with its own
     * connection grants and its own audit actor. 'agent' needs the
     * agent_identity entitlement (agents/agent-identity.ts).
     */
    runAs?: 'owner' | 'agent';
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
      /**
       * When verify fires. `on_final_output` (default) gates the final answer
       * and can send it back for revision. `every_n_steps` and `on_tool_result`
       * are advisory mid-run checks that inject course-correction feedback
       * without ending the run.
       */
      triggers?: Array<'on_final_output' | 'every_n_steps' | 'on_tool_result'>;
      everyNSteps?: number;
    };
    /**
     * Failure-memory constraints. `enabled` injects active constraints into the
     * system prompt; `autoLearn` records a new constraint when a run fails.
     * See AgentConstraint / AgentConstraintsService.
     */
    constraints?: {
      enabled?: boolean;
      autoLearn?: boolean;
      distill?: { providerId: string; model?: string };
    };
    /**
     * How the model sees the agent's tools (agents/agent-tool-mode.ts;
     * docs/design/code-mode.md, part E): `direct` (every definition),
     * `discover` (search_tools, get_tool, call_tool and the pinned tools),
     * `code` (discover plus run_code) or `auto` (discover once the
     * definitions pass the threshold). Absent: AGENT_TOOL_MODE_DEFAULT.
     */
    toolMode?: 'direct' | 'discover' | 'code' | 'auto';
    /** The `auto` threshold in tokens, instead of a share of the model's context window. */
    toolModeThresholdTokens?: number;
    /** Tools the model always sees in full, also in discover mode. */
    pinnedToolIds?: string[];
    /** run_code: what happens to changes and deletions, allowances, and extract()'s model (code-mode/code-write-policy.ts). */
    codeMode?: CodeModeConfig;
  };

  @Column({ default: false })
  isTemporary: boolean;

  @Column({ nullable: true })
  parentRunId: string;

  /**
   * An autonomous agent's team: the participants it works with, how they are
   * composed (strategy), and the rules of engagement. A participant is either
   * another agent or a model (a provider + model, or a routing policy), so an
   * organization with a single agent can still compose several models. See
   * CollaborationParticipant and AgentCollaborationHelper.
   *
   * `rules` are read by the run engine: maxTotalCost by the collaboration
   * helper before each participant (and by agent-step-processor across
   * sibling child runs), maxChainDepth by agent-runtime.service, and the three
   * formatting/escalation keys go into every participant's system prompt via
   * buildCollaborationContext.
   *
   * `allowRevision` and `sharedMemoryScope` used to sit in `rules` too, with
   * two checkboxes in autonomous-config.tsx writing them and nothing in
   * modules/agents reading either. They are gone rather than wired because
   * neither names an existing mechanism: a revision pass means inventing a
   * rule for when a sequential chain hands work back to an earlier agent and
   * how many times, and a shared memory scope means deciding what one
   * collaborator may see of another's memory. Both are features to design,
   * not calls to add.
   */
  @Column({ type: 'json', nullable: true })
  collaboration: AgentCollaboration | null;

  /**
   * An autonomous agent's models: its roles (main, drafter, checker,
   * panelists, explorers, a summariser, teammates -- each a model, or for
   * panelists and teammates another agent) and the strategy that says how
   * they work together on each step of the loop. The main role is mirrored
   * into `modelConfig` on every write. Null on a workflow agent, whose
   * multi-model shape is its graph. See autonomous-models.ts and
   * docs/autonomous-models.md.
   */
  @Column({ type: 'json', nullable: true })
  models: AgentModels | null;

  /**
   * The name, colours, logo and greeting people see on every channel of
   * this agent (web chat, widget, desktop and terminal apps). A channel
   * may override any field of it (AgentChannel.branding). Null means the
   * defaults, with the agent's own name.
   */
  @Column({ type: 'json', nullable: true })
  branding: ChannelBranding | null;

  /**
   * Who can use this agent's channels and what they may cost and keep:
   * sign-in, rate limits, spend caps, data retention and visitor rights.
   * A channel may override any of it (AgentChannel.visitorRules). Missing
   * fields take the defaults in agent-channels/channel-rules.ts.
   */
  @Column({ type: 'json', nullable: true })
  visitorRules: VisitorRules | null;

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
