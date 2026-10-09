import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Which compatible API a pod's call came in on. */
export type HostedModelCallProtocol = 'anthropic_messages' | 'openai_chat' | 'openai_responses';

/**
 * One model call a coding CLI in a hosted pod made through almyty's model
 * pass-through (docs/hosted-runners.md, "Models from inside a pod"). It
 * is a spend source beside agent_runs and agent_executions, so the
 * organization's budgets see what pods spend. No agent ran, so `agentId`
 * is always null; it exists so the spend queries read the tables alike.
 */
@Entity('hosted_model_calls')
@Index(['organizationId', 'createdAt'])
export class HostedModelCall {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'uuid', nullable: true })
  agentId: string | null;

  /** The workspace owner the pod token acts as. */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Index()
  @Column({ type: 'uuid' })
  hostedRunnerId: string;

  @Column({ type: 'uuid' })
  environmentId: string;

  @Column({ type: 'uuid' })
  workspaceId: string;

  @Column({ type: 'uuid', nullable: true })
  providerId: string | null;

  /** The catalog card that answered. */
  @Column({ type: 'uuid', nullable: true })
  modelId: string | null;

  @Column({ type: 'varchar', length: 255 })
  vendorModelId: string;

  @Column({ type: 'varchar', length: 32 })
  protocol: HostedModelCallProtocol;

  /** The upstream's HTTP status. */
  @Column({ type: 'int' })
  status: number;

  @Column({ type: 'boolean', default: false })
  stream: boolean;

  @Column({ type: 'int', default: 0 })
  inputTokens: number;

  @Column({ type: 'int', default: 0 })
  outputTokens: number;

  /** Dollars, like agent_runs.totalCost. */
  @Column({ type: 'double precision', default: 0 })
  totalCost: number;

  @Column({ type: 'int', default: 0 })
  durationMs: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
