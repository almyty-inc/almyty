import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Where a script stands. */
export type CodeExecutionStatus =
  /** Running in the sandbox. */
  | 'running'
  /** Finished; every call it made ran or was refused. */
  | 'completed'
  /** Threw, timed out or ran out of memory; `error` says which. */
  | 'failed'
  /** Finished with staged changes waiting on `approvalRequestId`. */
  | 'waiting_approval'
  /** Its change set was approved and has run (or stopped at a failure; see `changeSet`). */
  | 'approved'
  /** Its change set was rejected or expired; none of it ran. */
  | 'rejected';

/** One staged call of a script's change set (docs/design/code-mode.md, part D). */
export interface ChangeSetEntry {
  /** Position in the set, from 1; the stub's receipt carries it. */
  id: number;
  toolId: string;
  /** The tool's name, and its code name (`petstore.updatePet`). */
  toolName: string;
  codeName: string;
  /** What a person reads: the tool's summary. */
  title: string;
  arguments: Record<string, any>;
  /** The params fingerprint an approval of the set covers (tool-approval-gate.service paramsHash). */
  paramsHash: string;
  sideEffect: 'read' | 'write' | 'destructive';
  /** Why it was staged: its class under the write policy, or an amount rule. */
  reason: 'policy' | 'amount_rule';
  /** The amount rule it also trips, in plain words. */
  rule?: string;
  /** Once the set is decided and run: what happened to this entry. */
  outcome?: 'ran' | 'failed' | 'not_run';
  error?: string;
  toolExecutionId?: string;
}

/**
 * One `run_code` (docs/design/code-mode.md, part C, "The trace"): the
 * script as submitted, what it logged and returned, how it ended, its CPU
 * time and its change set. Each call the script made is an ordinary
 * `tool_executions` row with `codeExecutionId` set, so the call tree is a
 * query and retention treats it like tool_executions.
 */
@Entity('code_executions')
@Index(['organizationId', 'createdAt'])
export class CodeExecution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  organizationId: string;

  @Column('uuid', { nullable: true })
  @Index()
  runId: string | null;

  @Column('uuid', { nullable: true })
  agentId: string | null;

  @Column('uuid', { nullable: true })
  gatewayId: string | null;

  @Column('uuid', { nullable: true })
  userId: string | null;

  /** The script as submitted, before types were stripped. */
  @Column('text')
  code: string;

  /** log() output as the model saw it (capped, with the truncation marker). */
  @Column('text', { default: '' })
  logs: string;

  /** The return value (capped). */
  @Column('jsonb', { nullable: true })
  result: unknown;

  @Column('jsonb', { nullable: true })
  error: { message: string; line?: number; tool?: string } | null;

  @Column('varchar', { length: 24, default: 'running' })
  status: CodeExecutionStatus;

  /** The calls the script staged (empty when none). */
  @Column('jsonb', { default: () => "'[]'::jsonb" })
  changeSet: ChangeSetEntry[];

  @Column('uuid', { nullable: true })
  approvalRequestId: string | null;

  /** How many calls the script made (run, staged or refused). */
  @Column('integer', { default: 0 })
  callCount: number;

  /** CPU time of the sandbox worker (its busy event-loop time). */
  @Column('integer', { default: 0 })
  cpuMs: number;

  @Column('integer', { default: 0 })
  durationMs: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
