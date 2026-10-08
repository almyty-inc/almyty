import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A single-use ticket a hosted runner pod trades for its runner
 * credential (POST /runners/enroll). Only the sha256 of the token is
 * stored; the token itself goes into the pod's Secret and nowhere else.
 * It is useless after first use or once `expiresAt` passes.
 */
@Entity('runner_enrollment_tokens')
@Index(['hostedRunnerId'])
export class RunnerEnrollmentToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'uuid' })
  hostedRunnerId: string;

  /** sha256 hex of the token. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  tokenHash: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
