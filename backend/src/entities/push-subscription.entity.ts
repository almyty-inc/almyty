import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import type { PushWakeHealth, PushWakeSpec } from '../modules/agents/always-on/push-wakes/push-wake.types';

/** What a push subscription remembers between pushes. Never a secret. */
export interface PushSubscriptionState {
  /** The last "what changed" position (a sync token, a history id). */
  cursor?: string | null;
  /** What the subscribe step kept (a channel's id and resource id). */
  subscription?: Record<string, string> | null;
}

/**
 * One subscription at a service that pushes changes (docs/always-on.md,
 * "When a service tells it something changed"; push-wake.types.ts). It
 * owns the push address (`POST /push-wakes/:id`), the verification value
 * (a managed credential, `verifyCredentialId`), the cursor and the
 * subscription's health. Agents join it through `agent_push_wakes`.
 *
 * A service may allow only one subscription per resource (one watch per
 * mailbox), so agents that subscribe the same connection to the same
 * resource with the same spec share one row: `subscriptionKey` is unique
 * per organization. The subscription is stopped when the last agent leaves.
 */
@Entity('push_subscriptions')
@Index('UQ_push_subscriptions_key', ['organizationId', 'subscriptionKey'], { unique: true })
@Index('IDX_push_subscriptions_renew', ['renewAt'])
export class PushSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  /** The connection (an imported API) whose tools subscribe, renew, stop and read what changed. */
  @Column({ type: 'uuid', nullable: true })
  apiId: string | null;

  /** The preset it was made from, if any (push-wake-presets.ts); informational. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  presetKey: string | null;

  /** Connection + preset or spec + resource, hashed: who may share it (PushWakesService.keyOf). */
  @Column({ type: 'varchar', length: 64 })
  subscriptionKey: string;

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
  state: PushSubscriptionState;

  /** Pushes within this many seconds of the first are one read. */
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
