import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Why a pod-scoped model token stopped working before it expired. */
export type HostedModelTokenRevokeReason = 'pod_stopped' | 'replaced' | 'torn_down' | 'owner_left' | 'failed';

/**
 * The token a coding CLI in a hosted pod uses to call almyty's
 * Anthropic- and OpenAI-compatible endpoints (Decision 6). Minted by the
 * reconcile loop at every pod start and written into the pod's Secret;
 * only its sha256 is stored here. It names one hosted runner, so one
 * workspace, environment and organization, and runs as the workspace's
 * owner. It works on the model endpoints only, until `expiresAt`, and
 * stops at once when the pod stops (`revokedAt`).
 */
@Entity('hosted_model_tokens')
export class HostedModelToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'uuid' })
  hostedRunnerId: string;

  @Column({ type: 'uuid' })
  environmentId: string;

  @Column({ type: 'uuid' })
  workspaceId: string;

  /** Whose model access the token carries: the workspace's owner. */
  @Column({ type: 'uuid' })
  ownerUserId: string;

  /** sha256 hex of the token. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  tokenHash: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  revokedReason: HostedModelTokenRevokeReason | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
