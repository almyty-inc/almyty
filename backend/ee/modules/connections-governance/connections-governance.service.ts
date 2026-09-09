import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, IsNull, LessThan, Like, MoreThanOrEqual, LessThanOrEqual, Not, Repository } from 'typeorm';

import { Agent } from '../../../src/entities/agent.entity';
import { AuditAction, AuditLog, AuditResource } from '../../../src/entities/audit-log.entity';
import { ConnectionGrant, GrantPrincipalType } from '../../../src/entities/connection-grant.entity';
import {
  CONNECTION_POLICY_KINDS,
  ConnectionPolicy,
  ConnectionPolicyKind,
  ConnectionPolicyRule,
} from '../../../src/entities/connection-policy.entity';
import { Credential } from '../../../src/entities/credential.entity';
import { SpendBudget } from '../../../src/entities/spend-budget.entity';
import { User } from '../../../src/entities/user.entity';
import { OrganizationRole } from '../../../src/entities/user-organization.entity';
import { AuditLogService } from '../../../src/modules/audit-log/audit-log.service';
import { startOfPeriod } from '../../../src/modules/budgets/spend-period.util';
import { SpendService } from '../../../src/modules/budgets/spend.service';
import { ConnectorCatalogService } from '../../../src/modules/connections/connector-catalog.service';
import { NotificationsService } from '../../../src/modules/notifications/notifications.service';
import type { NotificationEventType } from '../../../src/modules/notifications/notification-types';
import { validatePolicyRule } from './connection-policy.rules';
import {
  evaluateConnect,
  evaluateUse,
  ExpiryAction,
  ExpiryActions,
  expiryActions,
  GovernedConnection,
  PolicyDecision,
  PolicyLike,
  RotationCandidate,
  rotationDue,
  secretSetAt,
  UsePrincipal,
} from './policy-evaluator';
import {
  CONNECTION_GRANT_REVOKER,
  CONNECTION_ROTATOR,
  ConnectionGrantRevoker,
  ConnectionRotator,
  GovernanceUseContext,
} from './seams';

/** How long an org's enabled policy list is served from memory. */
export const POLICY_CACHE_TTL_MS = 30_000;

/**
 * Notification event types this module emits. They are not yet in the
 * core `NOTIFICATION_EVENT_TYPES` list (a frontend contract); the
 * pipeline falls back to in-app + email defaults for unknown types.
 * TODO(lead): add these three to notification-types.ts and NOTIFICATION_DEFAULTS.
 */
export const CONNECTIONS_EXPIRING_EVENT = 'connections.expiring' as NotificationEventType;
export const CONNECTIONS_EXPIRED_EVENT = 'connections.expired' as NotificationEventType;
export const CONNECTIONS_ROTATION_EVENT = 'connections.rotation_due' as NotificationEventType;

/** Env: days of connection audit events kept per governed org. Unset = keep everything. */
export const CONNECTIONS_AUDIT_RETENTION_ENV = 'CONNECTIONS_AUDIT_RETENTION_DAYS';

const MAX_EXPORT_ROWS = 50_000;
const POLICY_AUDIT_PREFIX = 'connection_policy:';

export const EXPORT_COLUMNS = [
  'id',
  'createdAt',
  'organizationId',
  'userId',
  'userEmail',
  'action',
  'resourceType',
  'resourceId',
  'resourceName',
  'status',
  'ipAddress',
  'details',
] as const;

export interface PolicyInput {
  kind: ConnectionPolicyKind;
  name?: string | null;
  rule: unknown;
  enabled?: boolean;
}

export interface ReviewGrant {
  id: string;
  principalType: GrantPrincipalType;
  principalId: string;
  principalName: string | null;
  environment: string | null;
  permission: string;
  budgetId: string | null;
  expiresAt: Date | null;
  grantedBy: string | null;
  createdAt: Date;
}

export interface ReviewRow {
  connection: {
    id: string;
    name: string;
    connectorKey: string;
    accountLabel: string | null;
    owner: 'user';
    health: { status: string; checkedAt: Date | null; error: string | null };
    expiresAt: Date | null;
    secretSetAt: Date | null;
    createdAt: Date;
  };
  owner: { id: string; email: string | null; name: string | null };
  grants: ReviewGrant[];
  lastResolve: { at: Date; userId: string | null; agentId: string | null; workspaceId: string | null; purpose: string | null } | null;
}

export interface ExpiryRunResult {
  organizationId: string;
  warned: number;
  expired: number;
  revokedGrants: number;
  enforce: boolean;
}

export interface RotationRunResult {
  organizationId: string;
  rotated: number;
  failed: number;
  manual: number;
}

export interface ExportResult {
  format: 'json' | 'csv';
  contentType: string;
  filename: string;
  body: string;
  count: number;
  retentionDays: number | null;
}

export interface ExportFilters {
  from?: Date;
  to?: Date;
  limit?: number;
}

/**
 * Connections governance (EE, `connections_governance`). Policies are
 * org data; evaluation is the pure `policy-evaluator`; this service
 * loads rows, applies decisions and writes the audit trail.
 */
@Injectable()
export class ConnectionsGovernanceService {
  private readonly logger = new Logger(ConnectionsGovernanceService.name);

  /** Overridable clock so specs can drive expiry and rotation. */
  now: () => Date = () => new Date();

  private readonly cache = new Map<string, { at: number; policies: ConnectionPolicy[] }>();

  constructor(
    @InjectRepository(ConnectionPolicy) private readonly policies: Repository<ConnectionPolicy>,
    @InjectRepository(Credential) private readonly credentials: Repository<Credential>,
    @InjectRepository(ConnectionGrant) private readonly grants: Repository<ConnectionGrant>,
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(AuditLog) private readonly auditLogs: Repository<AuditLog>,
    @InjectRepository(SpendBudget) private readonly budgets: Repository<SpendBudget>,
    private readonly catalog: ConnectorCatalogService,
    private readonly auditLog: AuditLogService,
    private readonly spend: SpendService,
    @Optional() private readonly notifications?: NotificationsService,
    // TODO(lead): bind gate 5's RotationService: { provide: CONNECTION_ROTATOR, useExisting: RotationService }
    @Optional() @Inject(CONNECTION_ROTATOR) private readonly rotator?: ConnectionRotator,
    // TODO(lead): bind gate 2's GrantsService: { provide: CONNECTION_GRANT_REVOKER, useExisting: GrantsService }
    @Optional() @Inject(CONNECTION_GRANT_REVOKER) private readonly grantRevoker?: ConnectionGrantRevoker,
  ) {}

  // ------------------------------------------------------------------
  // Policies
  // ------------------------------------------------------------------

  async list(organizationId: string): Promise<ConnectionPolicy[]> {
    return this.policies.find({ where: { organizationId }, order: { createdAt: 'ASC' } });
  }

  async get(organizationId: string, id: string): Promise<ConnectionPolicy> {
    const row = await this.policies.findOne({ where: { id, organizationId } });
    if (!row) throw new NotFoundException({ code: 'CONNECTION_POLICY_NOT_FOUND', message: 'connection policy not found' });
    return row;
  }

  async create(organizationId: string, actorId: string | null, input: PolicyInput): Promise<ConnectionPolicy> {
    if (!input || !CONNECTION_POLICY_KINDS.includes(input.kind)) {
      throw new BadRequestException({ code: 'CONNECTION_POLICY_INVALID', message: `kind must be one of ${CONNECTION_POLICY_KINDS.join(', ')}` });
    }
    const rule = validatePolicyRule(input.kind, input.rule);
    const row = await this.policies.save(
      this.policies.create({
        organizationId,
        kind: input.kind,
        name: this.name(input.name),
        rule,
        enabled: input.enabled ?? true,
        createdBy: actorId,
      }),
    );
    this.invalidate(organizationId);
    await this.auditPolicy(AuditAction.CREATE, row, actorId);
    return row;
  }

  async update(organizationId: string, id: string, actorId: string | null, patch: Partial<PolicyInput>): Promise<ConnectionPolicy> {
    const row = await this.get(organizationId, id);
    if (patch.kind !== undefined && patch.kind !== row.kind) {
      throw new BadRequestException({ code: 'CONNECTION_POLICY_INVALID', message: 'kind cannot change; create a new policy' });
    }
    if (patch.rule !== undefined) row.rule = validatePolicyRule(row.kind, patch.rule);
    if (patch.name !== undefined) row.name = this.name(patch.name);
    if (patch.enabled !== undefined) row.enabled = !!patch.enabled;
    const saved = await this.policies.save(row);
    this.invalidate(organizationId);
    await this.auditPolicy(AuditAction.UPDATE, saved, actorId);
    return saved;
  }

  async remove(organizationId: string, id: string, actorId: string | null): Promise<void> {
    const row = await this.get(organizationId, id);
    await this.policies.remove(row);
    this.invalidate(organizationId);
    await this.auditPolicy(AuditAction.DELETE, { ...row, id }, actorId);
  }

  /** Enabled policies of an org, served from memory for POLICY_CACHE_TTL_MS. */
  async enabledPolicies(organizationId: string): Promise<ConnectionPolicy[]> {
    const hit = this.cache.get(organizationId);
    const at = this.now().getTime();
    if (hit && at - hit.at < POLICY_CACHE_TTL_MS) return hit.policies;
    const policies = await this.policies.find({ where: { organizationId, enabled: true } });
    this.cache.set(organizationId, { at, policies });
    return policies;
  }

  invalidate(organizationId: string): void {
    this.cache.delete(organizationId);
  }

  private name(value: string | null | undefined): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed ? trimmed.slice(0, 128) : null;
  }

  private async auditPolicy(action: AuditAction, row: ConnectionPolicy, actorId: string | null): Promise<void> {
    await this.auditLog.log({
      organizationId: row.organizationId,
      userId: actorId ?? undefined,
      action,
      resourceType: AuditResource.ORGANIZATION,
      resourceId: row.organizationId,
      resourceName: `${POLICY_AUDIT_PREFIX}${row.kind}`,
      details: { policyId: row.id, kind: row.kind, name: row.name, rule: row.rule, enabled: row.enabled },
    });
  }

  // ------------------------------------------------------------------
  // Decisions (used by the hook)
  // ------------------------------------------------------------------

  async decideConnect(organizationId: string, connectorKey: string, owner: 'org' | 'user'): Promise<PolicyDecision> {
    return evaluateConnect(await this.enabledPolicies(organizationId), connectorKey, owner);
  }

  async decideUse(organizationId: string, connection: GovernedConnection, principal: UsePrincipal, context: GovernanceUseContext = {}): Promise<PolicyDecision> {
    const policies = await this.enabledPolicies(organizationId);
    if (!policies.some((p) => p.kind === 'scope_rule')) return { allowed: true, reason: 'no scope rule applies' };
    const ctx = { ...context };
    if (!ctx.agentId && context.resourceType === 'agent' && context.resourceId) ctx.agentId = context.resourceId;
    if (!ctx.workspaceId && context.resourceType === 'workspace' && context.resourceId) ctx.workspaceId = context.resourceId;
    if (ctx.environment === undefined) {
      const agentId = ctx.agentId ?? principal.agentId;
      ctx.environment = agentId ? await this.environmentOf(agentId, organizationId) : null;
    }
    return evaluateUse(policies, connection, principal, ctx);
  }

  /**
   * A grant that carries a budget refuses the use once the budget's
   * period-to-date spend reaches its limit. Budgets are org-wide or
   * agent-scoped; the use's agent narrows the spend query when the
   * budget itself does not.
   */
  async assertBudget(organizationId: string, budgetId: string | null | undefined, agentId?: string | null): Promise<void> {
    if (!budgetId) return;
    const budget = await this.budgets.findOne({ where: { id: budgetId, organizationId } });
    if (!budget || !budget.active) return;
    const now = this.now();
    const spentCents = await this.spend.periodToDateCents({
      organizationId,
      agentId: budget.agentId ?? agentId ?? undefined,
      from: startOfPeriod(budget.periodType, now),
    });
    if (spentCents >= budget.limitCents) {
      throw new ForbiddenException({
        code: 'CONNECTION_BUDGET_EXHAUSTED',
        message: `the grant's budget is exhausted (${spentCents} of ${budget.limitCents} cents this ${budget.periodType})`,
        budgetId: budget.id,
        spentCents,
        limitCents: budget.limitCents,
      });
    }
  }

  /** An agent's environment: `metadata.environment`, `settings.environment`, or `production` when tagged so. */
  async environmentOf(agentId: string, organizationId: string): Promise<string | null> {
    const agent = await this.agents.findOne({ where: { id: agentId, organizationId } });
    return agent ? agentEnvironment(agent) : null;
  }

  // ------------------------------------------------------------------
  // Review dashboard
  // ------------------------------------------------------------------

  /**
   * User-scoped connections currently granted to agents or workspaces.
   * `environment: 'production'` keeps only grants to agents in that
   * environment; `any` keeps every agent and workspace grant.
   */
  async review(organizationId: string, environment: string = 'any'): Promise<ReviewRow[]> {
    const env = (environment || 'any').trim().toLowerCase();
    const connections = await this.credentials.find({
      where: { organizationId, connectorKey: Not(IsNull()), ownerUserId: Not(IsNull()) },
      order: { createdAt: 'ASC' },
    });
    if (!connections.length) return [];
    const ids = connections.map((c) => c.id);
    const grants = await this.grants.find({
      where: { organizationId, connectionId: In(ids), principalType: In(['agent', 'workspace']) },
      order: { createdAt: 'ASC' },
    });
    const agentIds = [...new Set(grants.filter((g) => g.principalType === 'agent').map((g) => g.principalId))];
    const agents = agentIds.length ? await this.agents.find({ where: { id: In(agentIds), organizationId } }) : [];
    const agentById = new Map(agents.map((a) => [a.id, a]));
    const ownerIds = [...new Set(connections.map((c) => c.ownerUserId!))];
    const owners = ownerIds.length ? await this.users.find({ where: { id: In(ownerIds) } }) : [];
    const ownerById = new Map(owners.map((u) => [u.id, u]));
    const now = this.now();

    const rows: ReviewRow[] = [];
    for (const connection of connections) {
      const own = grants
        .filter((g) => g.connectionId === connection.id)
        .filter((g) => !g.expiresAt || new Date(g.expiresAt).getTime() > now.getTime())
        .map((g) => {
          const agent = g.principalType === 'agent' ? agentById.get(g.principalId) : undefined;
          return {
            id: g.id,
            principalType: g.principalType,
            principalId: g.principalId,
            principalName: agent?.name ?? null,
            environment: agent ? agentEnvironment(agent) : null,
            permission: g.permission,
            budgetId: g.budgetId ?? null,
            expiresAt: g.expiresAt ?? null,
            grantedBy: g.grantedBy ?? null,
            createdAt: g.createdAt,
          } as ReviewGrant;
        })
        .filter((g) => env === 'any' || g.environment === env);
      if (!own.length) continue;
      const owner = ownerById.get(connection.ownerUserId!);
      const last = await this.auditLogs.findOne({
        where: { organizationId, resourceType: AuditResource.CONNECTION, action: AuditAction.CONNECTION_RESOLVE, resourceId: connection.id },
        order: { createdAt: 'DESC' },
      });
      rows.push({
        connection: {
          id: connection.id,
          name: connection.name,
          connectorKey: connection.connectorKey!,
          accountLabel: connection.accountLabel ?? null,
          owner: 'user',
          health: { status: connection.healthStatus ?? 'unknown', checkedAt: connection.healthCheckedAt ?? null, error: connection.healthError ?? null },
          expiresAt: connection.expiresAt ?? null,
          secretSetAt: secretSetAt(connection),
          createdAt: connection.createdAt,
        },
        owner: {
          id: connection.ownerUserId!,
          email: owner?.email ?? null,
          name: owner ? `${owner.firstName ?? ''} ${owner.lastName ?? ''}`.trim() || null : null,
        },
        grants: own,
        lastResolve: last
          ? {
              at: last.createdAt,
              userId: last.userId ?? null,
              agentId: last.details?.agentId ?? null,
              workspaceId: last.details?.workspaceId ?? null,
              purpose: last.details?.purpose ?? null,
            }
          : null,
      });
    }
    return rows;
  }

  /**
   * Revoke the agent and workspace grants (by default) on a user-scoped
   * connection from the review dashboard. Goes through gate 2's
   * GrantsService when bound, so its cache and audit stay consistent;
   * otherwise removes the rows and writes the same audit event.
   */
  async revokeGrants(organizationId: string, connectionId: string, actor: { id: string }, principalTypes: GrantPrincipalType[] = ['agent', 'workspace']): Promise<{ revoked: number; grantIds: string[] }> {
    const connection = await this.credentials.findOne({ where: { id: connectionId, organizationId } });
    if (!connection || !connection.connectorKey) throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND', message: 'connection not found' });
    const rows = await this.grants.find({ where: { organizationId, connectionId, principalType: In(principalTypes) } });
    const grantIds: string[] = [];
    for (const row of rows) {
      await this.revokeGrant(row, connection, actor.id, 'review');
      grantIds.push(row.id);
    }
    return { revoked: grantIds.length, grantIds };
  }

  private async revokeGrant(row: ConnectionGrant, connection: Credential, actorId: string | null, source: 'review' | 'expiry'): Promise<void> {
    if (this.grantRevoker && actorId) {
      await this.grantRevoker.revoke(row.id, { id: actorId }, connection.organizationId);
      return;
    }
    await this.grants.remove({ ...row } as ConnectionGrant);
    this.grantRevoker?.invalidate?.(connection.id);
    await this.auditLog.log({
      organizationId: connection.organizationId,
      userId: actorId ?? undefined,
      action: AuditAction.CONNECTION_REVOKE_GRANT,
      resourceType: AuditResource.CONNECTION,
      resourceId: connection.id,
      resourceName: connection.name,
      details: {
        grantId: row.id, principalType: row.principalType, principalId: row.principalId, permission: row.permission,
        owner: connection.ownerUserId ? 'user' : 'org', via: `governance.${source}`,
      },
    });
  }

  // ------------------------------------------------------------------
  // Expiry
  // ------------------------------------------------------------------

  /** Connections of an org that this layer governs (connectorKey set). */
  private async governedConnections(organizationId: string): Promise<Credential[]> {
    return this.credentials.find({ where: { organizationId, connectorKey: Not(IsNull()) }, order: { createdAt: 'ASC' } });
  }

  async expiring(organizationId: string): Promise<ExpiryActions> {
    const policies = await this.enabledPolicies(organizationId);
    return expiryActions(policies, await this.governedConnections(organizationId), this.now());
  }

  /**
   * Apply the org's expiry rule: warn owners inside the window, mark
   * rows past the maximum age `expired`, and with `enforce` revoke
   * their grants so nothing keeps resolving them.
   */
  async enforceExpiry(organizationId: string): Promise<ExpiryRunResult> {
    const policies = await this.enabledPolicies(organizationId);
    const connections = await this.governedConnections(organizationId);
    const byId = new Map(connections.map((c) => [c.id, c]));
    const actions = expiryActions(policies, connections, this.now());
    const result: ExpiryRunResult = { organizationId, warned: 0, expired: 0, revokedGrants: 0, enforce: actions.enforce };

    for (const action of actions.warn) {
      const connection = byId.get(action.connectionId)!;
      await this.notifyOwners(connection, CONNECTIONS_EXPIRING_EVENT, `Connection ${connection.name} expires soon`,
        `The secret behind ${connection.name} (${connection.connectorKey}) is ${action.ageDays} days old and expires on ${action.expiresOn.toISOString().slice(0, 10)} under your organization's expiry rule. Rotate it before then.`,
        { connectionId: connection.id, expiresOn: action.expiresOn.toISOString(), ageDays: action.ageDays, maxAgeDays: action.maxAgeDays });
      result.warned++;
    }

    for (const action of actions.expire) {
      const connection = byId.get(action.connectionId)!;
      connection.healthStatus = 'expired';
      connection.healthCheckedAt = this.now();
      connection.healthError = `secret is ${action.ageDays} days old; the organization's expiry rule allows ${action.maxAgeDays}`;
      await this.credentials.save(connection);
      let revoked = 0;
      if (actions.enforce) {
        const grants = await this.grants.find({ where: { connectionId: connection.id } });
        for (const grant of grants) {
          await this.revokeGrant(grant, connection, null, 'expiry');
          revoked++;
        }
      }
      await this.auditLog.log({
        organizationId,
        action: AuditAction.CONNECTION_VALIDATE,
        resourceType: AuditResource.CONNECTION,
        resourceId: connection.id,
        resourceName: connection.name,
        details: { connectorKey: connection.connectorKey, status: 'expired', source: 'governance.expiry', policyId: action.policyId, ageDays: action.ageDays, maxAgeDays: action.maxAgeDays, enforce: actions.enforce, revokedGrants: revoked },
      });
      await this.notifyOwners(connection, CONNECTIONS_EXPIRED_EVENT, `Connection ${connection.name} has expired`,
        actions.enforce
          ? `The secret behind ${connection.name} (${connection.connectorKey}) is ${action.ageDays} days old. It was marked expired and its ${revoked} grant(s) were revoked. Rotate it to bring it back.`
          : `The secret behind ${connection.name} (${connection.connectorKey}) is ${action.ageDays} days old and was marked expired. Rotate it.`,
        { connectionId: connection.id, ageDays: action.ageDays, maxAgeDays: action.maxAgeDays, revokedGrants: revoked });
      result.expired++;
      result.revokedGrants += revoked;
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Rotation
  // ------------------------------------------------------------------

  /** Connectors whose secrets can be rotated through the provider API. */
  async rotationCapabilities(organizationId: string): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const connector of await this.catalog.list(organizationId)) {
      const declared = (connector.capabilities ?? []).some((c) => c === 'rotate' || c === 'rotation');
      const viaRotator = this.rotator?.canRotate ? await this.rotator.canRotate(connector.key) : false;
      out[connector.key] = declared || !!viaRotator;
    }
    return out;
  }

  async rotationCandidates(organizationId: string): Promise<{ due: RotationCandidate[]; manual: RotationCandidate[] }> {
    const policies = await this.enabledPolicies(organizationId);
    const connections = await this.governedConnections(organizationId);
    return rotationDue(policies, connections, await this.rotationCapabilities(organizationId), this.now());
  }

  /**
   * Rotate every due connection through the rotator seam; tell owners
   * about the ones that need a manual rotation.
   */
  async rotateDue(organizationId: string): Promise<RotationRunResult> {
    const { due, manual } = await this.rotationCandidates(organizationId);
    const result: RotationRunResult = { organizationId, rotated: 0, failed: 0, manual: 0 };
    const manualToo: RotationCandidate[] = [...manual];
    for (const candidate of due) {
      let outcome: { rotated: boolean; manual?: boolean; error?: string };
      try {
        outcome = this.rotator ? await this.rotator.rotate(candidate.connectionId) : { rotated: false, manual: true };
      } catch (error: any) {
        outcome = { rotated: false, error: error?.message ?? 'rotation failed' };
      }
      await this.auditLog.log({
        organizationId,
        action: AuditAction.CONNECTION_ROTATE,
        resourceType: AuditResource.CONNECTION,
        resourceId: candidate.connectionId,
        details: { connectorKey: candidate.connectorKey, source: 'governance.schedule', policyId: candidate.policyId, ageDays: candidate.ageDays, everyDays: candidate.everyDays, rotated: outcome.rotated, manual: outcome.manual ?? false, error: outcome.error ?? null },
      });
      if (outcome.rotated) result.rotated++;
      else if (outcome.manual) manualToo.push(candidate);
      else result.failed++;
    }
    for (const candidate of manualToo) {
      const connection = await this.credentials.findOne({ where: { id: candidate.connectionId, organizationId } });
      if (!connection) continue;
      await this.notifyOwners(connection, CONNECTIONS_ROTATION_EVENT, `Rotate connection ${connection.name}`,
        `The secret behind ${connection.name} (${connection.connectorKey}) is ${candidate.ageDays} days old; your organization's rotation rule asks for a rotation every ${candidate.everyDays} days. ${connection.connectorKey} has no provider-side rotation, so rotate it by hand from the Connections page.`,
        { connectionId: connection.id, ageDays: candidate.ageDays, everyDays: candidate.everyDays });
      result.manual++;
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Audit export + retention
  // ------------------------------------------------------------------

  retentionDays(): number | null {
    const raw = process.env[CONNECTIONS_AUDIT_RETENTION_ENV]?.trim();
    if (!raw) return null;
    const days = parseInt(raw, 10);
    return Number.isInteger(days) && days > 0 ? days : null;
  }

  /** Every audit row of the connections event stream: connection, connector and policy events. */
  async collectEvents(organizationId: string, filters: ExportFilters = {}): Promise<AuditLog[]> {
    const limit = Math.min(filters.limit ?? MAX_EXPORT_ROWS, MAX_EXPORT_ROWS);
    const window = filters.from && filters.to
      ? { createdAt: Between(filters.from, filters.to) }
      : filters.from
        ? { createdAt: MoreThanOrEqual(filters.from) }
        : filters.to
          ? { createdAt: LessThanOrEqual(filters.to) }
          : {};
    return this.auditLogs.find({
      where: [
        { organizationId, resourceType: In([AuditResource.CONNECTION, AuditResource.CONNECTOR]), ...window },
        { organizationId, resourceType: AuditResource.ORGANIZATION, resourceName: Like(`${POLICY_AUDIT_PREFIX}%`), ...window },
      ],
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async export(organizationId: string, format: 'json' | 'csv', filters: ExportFilters = {}): Promise<ExportResult> {
    const rows = await this.collectEvents(organizationId, filters);
    const stamp = this.now().toISOString().slice(0, 10);
    const retentionDays = this.retentionDays();
    if (format === 'csv') {
      return { format, contentType: 'text/csv', filename: `connections-audit-${stamp}.csv`, body: toCsv(rows), count: rows.length, retentionDays };
    }
    const body = {
      documentType: 'connections-audit-export',
      standard: 'EU AI Act Annex IV (informative mapping)',
      generatedAt: this.now().toISOString(),
      organizationId,
      window: { from: filters.from?.toISOString() ?? null, to: filters.to?.toISOString() ?? null },
      retention: { days: retentionDays, source: retentionDays ? CONNECTIONS_AUDIT_RETENTION_ENV : 'unlimited' },
      annexIvMapping: ANNEX_IV_MAPPING,
      count: rows.length,
      events: rows,
    };
    return { format: 'json', contentType: 'application/json', filename: `connections-audit-${stamp}.json`, body: JSON.stringify(body, null, 2), count: rows.length, retentionDays };
  }

  /** Delete connection events older than the retention window for one org. Returns rows removed. */
  async sweepRetention(organizationId: string): Promise<number> {
    const days = this.retentionDays();
    if (!days) return 0;
    const cutoff = new Date(this.now().getTime() - days * 24 * 60 * 60 * 1000);
    const result = await this.auditLogs.delete({
      organizationId,
      resourceType: In([AuditResource.CONNECTION, AuditResource.CONNECTOR]),
      createdAt: LessThan(cutoff),
    });
    const removed = result?.affected ?? 0;
    if (removed > 0) {
      await this.auditLog.log({
        organizationId,
        action: AuditAction.RETENTION_SWEEP,
        resourceType: AuditResource.ORGANIZATION,
        resourceId: organizationId,
        resourceName: 'connections audit retention',
        details: { removed, retentionDays: days, cutoff: cutoff.toISOString(), stream: 'connections' },
      });
    }
    return removed;
  }

  // ------------------------------------------------------------------
  // Scheduling helpers
  // ------------------------------------------------------------------

  /** Organizations with at least one enabled policy of the given kinds. */
  async organizationsWithPolicies(kinds: ConnectionPolicyKind[]): Promise<string[]> {
    const rows = await this.policies.find({ where: { enabled: true, kind: In(kinds) }, select: { organizationId: true } as any });
    return [...new Set(rows.map((r) => r.organizationId))];
  }

  private async notifyOwners(connection: Credential, type: NotificationEventType, title: string, body: string, params: Record<string, unknown>): Promise<void> {
    if (!this.notifications) return;
    try {
      await this.notifications.emit({
        type,
        organizationId: connection.organizationId,
        userIds: connection.ownerUserId ? [connection.ownerUserId] : undefined,
        roleTarget: connection.ownerUserId ? undefined : { orgRoles: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
        title,
        body,
        link: '/connections',
        email: { template: type, params: { connectionName: connection.name, connectorKey: connection.connectorKey, ...params } },
      });
    } catch (error: any) {
      this.logger.warn(`connection notification ${type} failed: ${error?.message ?? error}`);
    }
  }
}

/** `metadata.environment`, `settings.environment`, or `production` when the agent is tagged so. */
export function agentEnvironment(agent: Pick<Agent, 'metadata' | 'settings'>): string | null {
  const meta = (agent.metadata ?? {}) as Record<string, any>;
  const settings = (agent.settings ?? {}) as Record<string, any>;
  const explicit = meta.environment ?? settings.environment;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim().toLowerCase();
  const tags: unknown = meta.tags;
  if (Array.isArray(tags) && tags.some((t) => typeof t === 'string' && t.toLowerCase() === 'production')) return 'production';
  return null;
}

export const ANNEX_IV_MAPPING: Record<string, string> = {
  '1(a) intended purpose and provider identity': 'connection_connect and connector_create events name the third party, the account and who connected it',
  '2(a) development methods and third-party tools': 'connection_resolve events list which external services each agent, workspace or user relied on and for what purpose',
  '2(g) cybersecurity measures': 'connection_validate, connection_rotate and connection_disconnect events show key hygiene: health checks, rotations, revocations and expiry enforcement',
  '3 monitoring, functioning and control': 'connection_grant and connection_revoke_grant events, and connection_policy changes, show who may use which connection under which rule',
  '8 change management': 'connection_policy create, update and delete events record every governance rule change with actor and time',
};

export function toCsv(rows: AuditLog[]): string {
  const header = EXPORT_COLUMNS.join(',');
  const lines = rows.map((row) => EXPORT_COLUMNS.map((col) => csvCell((row as any)[col])).join(','));
  return [header, ...lines].join('\n');
}

export function csvCell(value: unknown): string {
  if (value == null) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export type { ExpiryAction, PolicyLike, ConnectionPolicyRule };
