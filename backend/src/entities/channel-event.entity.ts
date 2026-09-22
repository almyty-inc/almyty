import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

export type ChannelDirection = 'inbound' | 'outbound';
export type ChannelEventStatus = 'received' | 'processed' | 'failed';

/**
 * Per-gateway channel event log. Observability surface for the
 * channel adapter subsystem — every inbound webhook payload and
 * every outbound response is logged here so operators can see what
 * actually flowed in/out for a given gateway.
 *
 * Payload is truncated to MAX_PAYLOAD_BYTES (set in service) so a
 * spammy webhook doesn't blow up the audit table. errorMessage is
 * populated on direction='outbound' when sendResponse throws and
 * on direction='inbound' when verifyWebhook rejects.
 *
 * Retention: a sweeper drops events older than 30 days (configurable
 * per org). Implemented in a follow-up; the index supports the sweep.
 */
@Entity('channel_events')
@Index(['gatewayId', 'createdAt'])
@Index(['organizationId', 'createdAt'])
// One delivery, one run: the partial unique index is what rejects a
// platform's redelivery of a message this gateway already accepted.
// Partial so the NULL deliveryId every other event row carries stays
// repeatable. Created in migration 1750799000000-ChannelDeliveryDedupe.
@Index('UQ_channel_events_gateway_delivery', ['gatewayId', 'deliveryId'], {
  unique: true,
  where: '"deliveryId" IS NOT NULL',
})
export class ChannelEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @Column()
  gatewayId: string;

  @Column({ type: 'varchar', length: 32 })
  channelType: string;

  @Column({ type: 'varchar', length: 16 })
  direction: ChannelDirection;

  @Column({ type: 'varchar', length: 16 })
  status: ChannelEventStatus;

  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, any> | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  /**
   * Cross-link to the AgentRun this event belongs to.
   *
   * Set on an inbound event once the delivery has a run — whether a new
   * one or the active run its thread reattached to — and on the
   * outbound reply that run produced, so "the bot never answered me at
   * 14:05" leads from the inbound row to the run and to what the
   * platform said about the reply. NULL only where there is no run:
   * a rejected signature, a malformed payload, a rate-limited sender.
   */
  @Column({ type: 'uuid', nullable: true })
  runId: string | null;

  /**
   * The platform's own id for the delivery that produced this event,
   * from the adapter's `deliveryId`. Set on inbound 'received' events
   * only; NULL everywhere else (outbound, rejected, and the channels
   * whose platform offers nothing stable to key on).
   *
   * A partial unique index on (gatewayId, deliveryId) makes this the
   * claim on a delivery: the first insert wins and a redelivery of the
   * same platform message fails the insert, so one user message cannot
   * produce two runs and two replies. The index is partial because NULL
   * must stay repeatable.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  deliveryId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
