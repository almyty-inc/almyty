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
   * Optional cross-link to an AgentRun spawned from an inbound event.
   * NULL for outbound events and for inbound events that never produced
   * a run (rejected, malformed, no agent attached to gateway).
   */
  @Column({ type: 'uuid', nullable: true })
  runId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
