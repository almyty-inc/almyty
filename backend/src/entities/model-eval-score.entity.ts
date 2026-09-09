import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Organization } from './organization.entity';
import { ModelVersion } from './model-version.entity';

/**
 * Interim eval score, one row per (version, suite, run). The verifier
 * panel writes it today; when the observability scores API ships the
 * writer is swapped and this table stays.
 */
@Entity('model_eval_scores')
@Index(['organizationId', 'modelVersionId', 'suite'])
export class ModelEvalScore {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @Column({ type: 'uuid' })
  modelVersionId: string;

  @ManyToOne(() => ModelVersion, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'modelVersionId' })
  modelVersion: ModelVersion;

  @Column({ type: 'varchar' })
  suite: string;

  @Column({ type: 'numeric', precision: 8, scale: 4 })
  score: string;

  @Column({ type: 'boolean' })
  passed: boolean;

  /** Where the score came from (run id, verifier panel id, CI job). */
  @Column({ type: 'varchar', nullable: true })
  runRef: string | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;
}
