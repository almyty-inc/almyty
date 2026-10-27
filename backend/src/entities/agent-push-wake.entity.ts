import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * An always-on agent's push wake (docs/always-on.md, "When a service tells
 * it something changed"): the agent's membership in a push subscription
 * (push-subscription.entity.ts). Every push the subscription takes, and
 * what changed, wakes each agent that is a member and is on.
 */
@Entity('agent_push_wakes')
@Index('IDX_agent_push_wakes_agent', ['agentId'])
@Index('UQ_agent_push_wakes_agent_subscription', ['agentId', 'subscriptionId'], { unique: true })
export class AgentPushWake {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'uuid' })
  agentId: string;

  @Column({ type: 'uuid' })
  subscriptionId: string;

  @Column({ type: 'timestamptz', nullable: true })
  lastWakeAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
