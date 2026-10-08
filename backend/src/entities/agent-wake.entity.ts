import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** What woke an always-on agent. */
export const WAKE_SOURCES = ['timer', 'channel', 'webhook', 'connection', 'manual'] as const;
export type WakeSource = (typeof WAKE_SOURCES)[number];

/**
 * Where a wake is. `queued` waits for the agent; `consumed` was handed to a
 * run (`runId`); `coalesced` was folded away because the inbox was full;
 * `dropped` was never delivered (the agent was off or paused, or the wake
 * was the agent's own message coming back).
 */
export const WAKE_STATUSES = ['queued', 'consumed', 'coalesced', 'dropped'] as const;
export type WakeStatus = (typeof WAKE_STATUSES)[number];

/**
 * The inbox between what happens and what an always-on agent does about it
 * (docs/always-on.md). Every wake source writes a row here through
 * AlwaysOnService.wake, and nothing else starts an always-on run. The run
 * that picks a row up is recorded on it.
 *
 * `summary` is the one bounded line the agent reads. `payload` is bounded
 * JSON and never carries a secret. `dedupeKey` is unique per agent, so a
 * timer tick, a redelivered message or a connection event repeated on the
 * same day is one wake.
 */
@Entity('agent_wakes')
@Index('UQ_agent_wakes_agent_dedupe', ['agentId', 'dedupeKey'], { unique: true })
@Index('IDX_agent_wakes_agent_status', ['agentId', 'status', 'createdAt'])
export class AgentWake {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'uuid' })
  agentId: string;

  @Column({ type: 'varchar', length: 16 })
  source: WakeSource;

  /** The channel, connection or job behind the wake. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  sourceRef: string | null;

  @Column({ type: 'varchar', length: 500 })
  summary: string;

  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, any> | null;

  @Column({ type: 'varchar', length: 255 })
  dedupeKey: string;

  @Column({ type: 'varchar', length: 12, default: 'queued' })
  status: WakeStatus;

  @Column({ type: 'uuid', nullable: true })
  runId: string | null;

  /** Why a wake was dropped or coalesced. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  note: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  consumedAt: Date | null;
}
