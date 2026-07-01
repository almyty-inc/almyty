import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * EE (advanced_rbac): a custom, org-defined role carrying an explicit
 * permission set that extends the built-in owner/admin/member/viewer
 * roles. The community build ships only the fixed roles; a licensed
 * deployment can mint bespoke roles (e.g. "billing-auditor",
 * "release-manager") and grant them a curated slice of permissions.
 *
 * Permissions are opaque `resource:action` strings (e.g. `agents:read`,
 * `tools:manage`, `audit:export`). The evaluator treats them as a flat
 * grant set; wildcards (`agents:*`, `*:read`, `*`) are supported.
 */
@Entity('custom_roles')
@Index(['organizationId', 'name'], { unique: true })
export class CustomRole {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 64 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Flat set of `resource:action` grants; wildcards allowed. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  permissions: string[];

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
