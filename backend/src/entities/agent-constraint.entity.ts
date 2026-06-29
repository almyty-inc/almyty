import {
  Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';

import { Organization } from './organization.entity';

/**
 * A learned (or hand-authored) constraint for an agent — the "failure memory"
 * complement to PromotedSkill. Active constraints are injected into the agent's
 * system prompt so it stops repeating past mistakes. Distinct from the memory
 * module (embedding recall): these are hard text rules, always injected.
 */
@Entity('agent_constraints')
@Index(['organizationId', 'agentId'])
export class AgentConstraint {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @Column()
  agentId: string;

  @Column({ type: 'text' })
  rule: string;

  /** The failed run this was learned from (null for hand-authored rules). */
  @Column({ nullable: true })
  sourceRunId: string;

  /** Inactive constraints are kept for history but not injected. */
  @Column({ default: true })
  active: boolean;

  /** 'learned' (auto-distilled from a failure) or 'manual'. */
  @Column({ type: 'varchar', default: 'manual' })
  origin: 'learned' | 'manual';

  @Column({ nullable: true })
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;
}
