import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Connections governance (EE, entitlement `connections_governance`).
 * Org-wide rules over the Connections layer. The row is core data so the
 * schema, migration and repository live with the other entities; every
 * read, write and evaluation happens in
 * `backend/ee/modules/connections-governance`.
 *
 * One row is one rule of one `kind`; `rule` is validated per kind by
 * the EE module before it is stored (`connection-policy.rules.ts`).
 */
export const CONNECTION_POLICY_KINDS = [
  'connector_allowlist',
  'connector_denylist',
  'scope_rule',
  'expiry_rule',
  'rotation_rule',
] as const;
export type ConnectionPolicyKind = (typeof CONNECTION_POLICY_KINDS)[number];

/** Who a scope rule applies to: the principal kind the connection is resolved for. */
export const SCOPE_PRINCIPAL_KINDS = ['agent', 'workspace', 'user', 'team', 'role'] as const;
export type ScopePrincipalKind = (typeof SCOPE_PRINCIPAL_KINDS)[number];

/** `connector_allowlist` and `connector_denylist`: which connectors may be connected at all. */
export interface ConnectorListRule {
  connectorKeys: string[];
  /** Restrict the list to org- or user-scoped connects; both when absent. */
  owners?: Array<'org' | 'user'>;
}

/**
 * `scope_rule`: what a principal kind may resolve, optionally only in
 * some environments (an agent's `metadata.environment`, for example
 * `production`). `requireOwner: 'org'` refuses user-scoped connections;
 * `approvedConnectorsOnly` additionally requires the connector to be on
 * an enabled `connector_allowlist`.
 */
export interface ScopeRule {
  principalKinds: ScopePrincipalKind[];
  environments?: string[];
  requireOwner: 'org';
  approvedConnectorsOnly?: boolean;
}

/**
 * `expiry_rule`: a secret older than `maxAgeDays` is expired; owners
 * are warned `warnDays` before. With `enforce`, expiry also revokes the
 * connection's grants so nothing keeps resolving it.
 */
export interface ExpiryRule {
  maxAgeDays: number;
  warnDays: number;
  enforce: boolean;
}

/**
 * `rotation_rule`: rotate the secret every `everyDays` through the
 * provider's API. `requireProviderApi` is always true: a connector
 * without API rotation is reported as needing a manual rotation.
 */
export interface RotationRule {
  connectorKeys?: string[];
  everyDays: number;
  requireProviderApi: true;
}

export type ConnectionPolicyRule = ConnectorListRule | ScopeRule | ExpiryRule | RotationRule;

@Entity('connection_policies')
@Index(['organizationId', 'kind', 'enabled'])
export class ConnectionPolicy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 32 })
  kind: ConnectionPolicyKind;

  @Column({ type: 'varchar', length: 128, nullable: true })
  name: string | null;

  @Column({ type: 'json' })
  rule: ConnectionPolicyRule;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
