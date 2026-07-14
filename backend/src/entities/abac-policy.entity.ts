import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type AbacEffect = 'allow' | 'deny';

/**
 * A single attribute condition. `attr` is a dot-path resolved against
 * the flattened evaluation context (`subject.*`, `resource.*`,
 * `context.*`). Example: `{ attr: 'resource.amount', op: 'gt', value: 1000 }`.
 */
export interface AbacCondition {
  attr: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'contains';
  value: unknown;
}

/**
 * EE (advanced_rbac): an attribute-based access-control policy. Beyond
 * static role→permission grants, ABAC lets an org express rules over
 * request attributes — e.g. "deny tools:execute when
 * resource.environment == 'production' unless subject.oncall == true".
 *
 * Evaluation (see PolicyEvaluatorService):
 *   - policies are filtered to those whose `action` matches (or `*`),
 *   - every `conditions` entry must hold (AND) for the policy to apply,
 *   - an applicable `deny` always wins over any `allow` (deny-overrides),
 *   - higher `priority` breaks ties among same-effect policies.
 */
@Entity('abac_policies')
@Index(['organizationId', 'active'])
export class AbacPolicy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 128 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 8, default: 'allow' })
  effect: AbacEffect;

  /** Action this policy governs, e.g. `tools:execute`, or `*` for any. */
  @Column({ type: 'varchar', length: 128, default: '*' })
  action: string;

  /** ANDed conditions; empty array means "always applies". */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  conditions: AbacCondition[];

  @Column({ type: 'int', default: 0 })
  priority: number;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
