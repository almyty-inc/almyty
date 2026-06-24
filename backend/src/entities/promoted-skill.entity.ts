import {
  Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';

import { Organization } from './organization.entity';

/**
 * A reusable skill distilled from a successful agent run — the "promote" step
 * of the run -> verify -> promote -> replay loop. The rendered SKILL.md
 * (agentskills.io spec) is stored in `content` so serving is a plain read; the
 * source run/agent are retained for provenance and re-promotion.
 */
@Entity('promoted_skills')
@Index(['organizationId', 'createdAt'])
@Index(['organizationId', 'slug'])
export class PromotedSkill {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  /** Source agent (kept for provenance; nulled if the agent is deleted). */
  @Column({ nullable: true })
  agentId: string;

  /** The run this skill was promoted from (nulled if the run is deleted). */
  @Column({ nullable: true })
  sourceRunId: string;

  @Column()
  name: string;

  /** Kebab-case identifier used as the served skill's `name`. */
  @Column()
  slug: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  /** Rendered SKILL.md (frontmatter + body). Served verbatim. */
  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'json', nullable: true })
  frontmatter: Record<string, any>;

  /** Example input captured from the source run, for documentation. */
  @Column({ type: 'json', nullable: true })
  inputExample: any;

  /** Bumped when an existing (org, slug) skill is re-promoted from a newer run. */
  @Column({ default: 1 })
  version: number;

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
