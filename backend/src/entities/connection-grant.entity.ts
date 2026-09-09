import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Credential } from './credential.entity';
import { SpendBudget } from './spend-budget.entity';

/**
 * Who a connection may be handed to. `user`, `team`, `role` and `agent`
 * principals are identity-shaped; `workspace` is a run location. A
 * workspace is only ever a grant target, never a connection owner
 * (docs/design/connections-grants.md).
 */
export const GRANT_PRINCIPAL_TYPES = ['user', 'team', 'role', 'agent', 'workspace'] as const;
export type GrantPrincipalType = (typeof GRANT_PRINCIPAL_TYPES)[number];

/** `use` resolves the secret for a run; `manage` additionally edits grants. */
export const GRANT_PERMISSIONS = ['use', 'manage'] as const;
export type GrantPermission = (typeof GRANT_PERMISSIONS)[number];

/**
 * Connections layer, gate 2. A Credential row that is a connection
 * (connectorKey set) is used by anything other than its owner only
 * through a grant. One row per (connection, principal); re-granting
 * updates the row in place.
 *
 * `principalId` is a uuid for user / team / agent / workspace and the
 * role name (`owner`, `admin`, `member`, `viewer`) for `role`.
 *
 * `budgetId` is stored now so a grant can carry its own spend ceiling;
 * enforcement lands with the EE governance module.
 */
@Entity('connection_grants')
@Index(['connectionId', 'principalType', 'principalId'], { unique: true })
@Index(['organizationId', 'principalType', 'principalId'])
export class ConnectionGrant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'uuid' })
  connectionId: string;

  @ManyToOne(() => Credential, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'connectionId' })
  connection?: Credential;

  @Column({ type: 'varchar', length: 16 })
  principalType: GrantPrincipalType;

  @Column({ type: 'varchar', length: 64 })
  principalId: string;

  @Column({ type: 'varchar', length: 8, default: 'use' })
  permission: GrantPermission;

  @Column({ type: 'uuid', nullable: true })
  budgetId: string | null;

  @ManyToOne(() => SpendBudget, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'budgetId' })
  budget?: SpendBudget | null;

  @Column({ type: 'uuid', nullable: true })
  grantedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;
}
