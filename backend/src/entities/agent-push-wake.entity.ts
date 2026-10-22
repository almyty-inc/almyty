import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import type { PushWakeHealth, PushWakeSpec } from '../modules/agents/always-on/push-wakes/push-wake.types';

/** What a push wake remembers between pushes. Never a secret. */
export interface PushWakeState {
  /** The last "what changed" position (a sync token, a history id). */
  cursor?: string | null;
  /** What the subscribe step kept (a channel's id and resource id). */
  subscription?: Record<string, string> | null;
}

/**
 * A push wake source of an always-on agent (docs/always-on.md, "When a
 * service tells it something changed"; push-wake.types.ts). The service
 * calls `POST /push-wakes/:id`, the call is verified as `spec` says, and
 * after the debounce window the agent wakes with what changed.
 *
 * The verification value (a shared value, an HMAC key) is a managed
 * credential (`verifyCredentialId`), never a column here. `settings` holds
 * what the person filled in for the preset (a topic name, a calendar id).
 */
@Entity('agent_push_wakes')
@Index('IDX_agent_push_wakes_agent', ['agentId'])
@Index('IDX_agent_push_wakes_renew', ['renewAt'])
export class AgentPushWake {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'uuid' })
  agentId: string;

  /** The connection (an imported API) whose tools subscribe, renew, stop and read what changed. */
  @Column({ type: 'uuid', nullable: true })
  apiId: string | null;

  /** The preset it was made from, if any (push-wake-presets.ts); informational. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  presetKey: string | null;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'jsonb' })
  spec: PushWakeSpec;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  settings: Record<string, string>;

  /** The managed credential holding the shared value or HMAC key. */
  @Column({ type: 'uuid', nullable: true })
  verifyCredentialId: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  state: PushWakeState;

  /** Pushes within this many seconds of the first are one wake. */
  @Column({ type: 'int', default: 10 })
  debounceSeconds: number;

  @Column({ type: 'varchar', length: 16, default: 'unknown' })
  health: PushWakeHealth;

  @Column({ type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastErrorAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastPushAt: Date | null;

  @Column({ type: 'int', default: 0 })
  pushCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastWakeAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastRenewedAt: Date | null;

  /** When the service closes the subscription, as its answer said. */
  @Column({ type: 'timestamptz', nullable: true })
  subscriptionExpiresAt: Date | null;

  /** When the renewal sweep subscribes again; null when it never needs to. */
  @Column({ type: 'timestamptz', nullable: true })
  renewAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
