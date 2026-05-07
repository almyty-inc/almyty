import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Runner } from './runner.entity';

/**
 * One row per Streamable HTTP session a runner has held. Mostly an
 * audit trail: when the runner connected, when it disconnected, and
 * what session id the transport assigned. The active session is the
 * one with disconnectedAt = NULL; queries that need the runner's live
 * connection look up by (runner_id, disconnectedAt IS NULL).
 *
 * Wired this for completeness even though v1.0 single-runner-per-account
 * makes some of this overkill — the data model is meant to support
 * multi-runner without a future migration.
 */
@Entity('runner_sessions')
@Index(['runnerId'])
@Index(['streamableSessionId'])
@Index(['runnerId', 'disconnectedAt'])
export class RunnerSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  runnerId: string;

  @ManyToOne(() => Runner, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'runnerId' })
  runner?: Runner;

  /**
   * Streamable HTTP session id (`Mcp-Session-Id` header value). The
   * routing layer uses this to address envelopes to a specific runner
   * connection; transports.push(streamableSessionId, ...).
   */
  @Column()
  streamableSessionId: string;

  /** Remote address at connect time, for audit. */
  @Column({ nullable: true })
  remoteAddress: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  connectedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  disconnectedAt: Date | null;
}
