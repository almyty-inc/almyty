import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type ModelChangeKind = 'new' | 'unavailable';

/**
 * One model appearing on, or dropping off, a provider connection, as a
 * sync or a check saw it. The record behind the "new models" and "model
 * no longer available" notices (model-catalog/notices): what changed, why,
 * which agents used it, and whether its email went out yet.
 *
 * Kept, not a queue: the catalog reads recent 'new' rows to mark models
 * "New", the unavailable rows of the last day are the flap guard (a
 * provider that drops a model and lists it again does not mail anyone
 * twice in a day), and each person's daily digest reads the rows since
 * their last one.
 */
@Entity('model_change_events')
@Index(['createdAt'])
@Index(['organizationId', 'providerId', 'vendorModelId', 'kind', 'createdAt'])
export class ModelChangeEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  /** The connection. No foreign key: the event outlives a removed connection. */
  @Column({ type: 'uuid' })
  providerId: string;

  /** The connection's name when it happened, for messages sent later. */
  @Column({ type: 'varchar', length: 255 })
  providerName: string;

  /** The model card, when there is one. */
  @Column({ type: 'uuid', nullable: true })
  modelId: string | null;

  @Column({ type: 'varchar', length: 300 })
  vendorModelId: string;

  @Column({ type: 'varchar', length: 300 })
  modelName: string;

  @Column({ type: 'varchar', length: 16 })
  kind: ModelChangeKind;

  /**
   * For a new model: whether its connection offers it. One whose
   * connection takes new models only once they are ticked is announced as
   * not allowed there, so the owner can tick it.
   */
  @Column({ type: 'boolean', default: true })
  offered: boolean;

  /** Why a model became unavailable, in plain words. */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  /** Agents that used the model when it became unavailable. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  agentIds: string[];

  /**
   * When the immediate email went out (an unavailable model an agent uses).
   * Every other row goes into each recipient's daily digest; who has had
   * theirs is users.modelDigestSentAt.
   */
  @Column({ type: 'timestamptz', nullable: true })
  notifiedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
