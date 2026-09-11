import {
  Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index, Unique,
} from 'typeorm';

import { Organization } from './organization.entity';

/**
 * A named slot in an agent that some model fills.
 *
 * This is the vendor-independence fix. Before it, the model an agent used
 * lived on each node, so moving an agent from a hosted frontier model to
 * your own fine-tune meant editing the graph, node by node, and doing it
 * again for the next model. A role names the job ("principal",
 * "verifier", "summariser"), and the binding says what fills it, so
 * changing model is a binding change and the graph never moves.
 *
 * L4 in docs/design/layers.md. Depends on L2, and on L3 only when a
 * binding asks to be resolved: a pinned role never calls the router, so
 * roles are fully usable with routing switched off.
 */

/** What fills a role. */
export type RoleBinding =
  /**
   * A named model, always. Never touches the router, which is what makes
   * roles usable on their own.
   */
  | { mode: 'pinned'; modelId: string }
  /** Chosen per run by L3 from a policy. */
  | { mode: 'resolved'; policy: Record<string, unknown> };

/**
 * What the role needs from whatever fills it. Kept separate from the
 * binding because it stays true when the binding changes: a verifier
 * needs tool use whether it is pinned or resolved.
 */
export interface RoleRequirement {
  capabilities?: Record<string, boolean>;
  minContext?: number;
  maxBlendedPrice?: number;
  privacyTierCeiling?: string;
  region?: string;
  tags?: string[];
}

@Entity('agent_roles')
@Index(['organizationId', 'agentId'])
@Unique(['agentId', 'key'])
export class AgentRole {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @Column()
  agentId: string;

  /**
   * Stable identifier a node references. Renaming it breaks those
   * references, so it is chosen once and the display name carries any
   * later change of mind.
   */
  @Column({ length: 64 })
  key: string;

  @Column({ length: 128 })
  displayName: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  requirement: RoleRequirement;

  @Column({ type: 'jsonb' })
  binding: RoleBinding;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
