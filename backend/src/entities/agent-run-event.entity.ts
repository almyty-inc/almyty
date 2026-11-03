import { Entity, Column, PrimaryColumn, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { AgentRun } from './agent-run.entity';

/**
 * One event of an autonomous run's append-only log (docs/design/durable-runs.md).
 *
 * Written in the same transaction as the run row by the step commit, with
 * `seq` = the run's `headSeq` + 1.. so a run's events are contiguous from 1.
 * The primary key (runId, seq) is also the index "events after seq N for
 * run R" reads. Deleted with its run (ON DELETE CASCADE), which is how
 * retention and visitor erasure reach it. Event types and payloads:
 * modules/agents/run-events.ts.
 */
@Entity('agent_run_events')
export class AgentRunEvent {
  @PrimaryColumn('uuid')
  runId: string;

  @PrimaryColumn('int')
  seq: number;

  @Column({ type: 'varchar', length: 64 })
  type: string;

  /** The step number of the commit that wrote it. */
  @Column({ type: 'int', nullable: true })
  step: number | null;

  @Column({ type: 'jsonb', default: {} })
  payload: Record<string, any>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => AgentRun, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'runId' })
  run?: AgentRun;
}
