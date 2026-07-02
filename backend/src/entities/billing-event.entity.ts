import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Stripe webhook idempotency ledger. Every processed event id is recorded so
 * that Stripe's at-least-once delivery (retries, replays) cannot double-apply a
 * subscription change. The webhook handler checks this table before acting and
 * inserts the row after — the unique primary key makes concurrent duplicates a
 * no-op.
 */
@Entity('billing_events')
export class BillingEvent {
  /** Stripe event id (evt_...). Natural primary key = built-in dedupe. */
  @PrimaryColumn()
  eventId: string;

  /** Stripe event type, e.g. customer.subscription.updated. */
  @Column()
  type: string;

  /** Organization the event resolved to, when known. */
  @Index()
  @Column({ nullable: true })
  organizationId: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  processedAt: Date;
}
