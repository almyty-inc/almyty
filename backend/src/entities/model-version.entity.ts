import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { VersionedEntity } from 'typeorm-versions';
import { Organization } from './organization.entity';

/**
 * Immutable weights in the registry. Vendor-neutral by construction: the
 * registry URI is S3-compatible by default (`s3://bucket/prefix@etag`),
 * `hf://org/repo@sha` is an optional read-only source, `file://` is a
 * runner-local path. The manifest (almyty-manifest.json next to the
 * safetensors) is what makes a version portable between adapters.
 */

export interface ModelLineage {
  trainingJobId?: string;
  datasetRef?: string;
  parentVersionId?: string;
}

@Entity('model_versions')
@VersionedEntity()
@Index(['organizationId', 'base'])
export class ModelVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @Column()
  name: string;

  @Column({ type: 'varchar' })
  registryUri: string;

  @Column({ type: 'varchar' })
  base: string;

  @Column({ type: 'bigint', nullable: true })
  sizeBytes: string | null;

  @Column({ type: 'varchar', array: true, default: '{}' })
  quantizations: string[];

  @Column({ type: 'json', nullable: true })
  lineage: ModelLineage | null;

  /** Interim: the verifier panel writes here until the scores API exists. */
  @Column({ type: 'json', nullable: true })
  evalScores: Record<string, any> | null;

  @Column({ type: 'varchar', nullable: true })
  manifestSha: string | null;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;
}
