import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent } from '../../../entities/agent.entity';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import {
  ConnectionGrant,
  GRANT_PERMISSIONS,
  GRANT_PRINCIPAL_TYPES,
  GrantPermission,
  GrantPrincipalType,
} from '../../../entities/connection-grant.entity';
import { Credential } from '../../../entities/credential.entity';
import { SpendBudget } from '../../../entities/spend-budget.entity';
import { Team } from '../../../entities/team.entity';
import { OrganizationRole, UserOrganization } from '../../../entities/user-organization.entity';
import { UserTeam } from '../../../entities/user-team.entity';
import { Workspace } from '../../../entities/workspace.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { ConnectionPrincipal, membershipOf } from '../connections.permissions';
import {
  canManage,
  canUse,
  ConnectionLike,
  GrantContext,
  GrantDecision,
  GrantPrincipal,
  hasManagePermission,
  isExpired,
} from './grant-check';

/** How long a connection's grant list is served from memory. */
export const GRANT_CACHE_TTL_MS = 30_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Thrown by `assertCanUse`. A ForbiddenException, so it is a 403 over
 * HTTP; consumers that want to branch on it check `code`.
 */
export class ConnectionNotGrantedError extends ForbiddenException {
  readonly code = 'CONNECTION_NOT_GRANTED';

  constructor(readonly connectionId: string, readonly reason: string) {
    super({ code: 'CONNECTION_NOT_GRANTED', message: `connection is not granted: ${reason}`, reason, connectionId });
  }
}

export interface GrantInput {
  principalType: GrantPrincipalType;
  principalId: string;
  permission?: GrantPermission;
  budgetId?: string | null;
  expiresAt?: string | Date | null;
}

/** The run context a consumer passes through the resolver seam. */
export interface UseContext extends GrantContext {
  resourceType?: string;
  resourceId?: string;
}

/** The request user as JwtStrategy attaches it. */
export interface RequestUserLike extends ConnectionPrincipal {
  currentOrganizationId?: string;
}

export interface PrincipalContext extends GrantContext {
  organizationId?: string;
}

export interface GrantView {
  id: string;
  connectionId: string;
  principalType: GrantPrincipalType;
  principalId: string;
  permission: GrantPermission;
  budgetId: string | null;
  grantedBy: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  expired: boolean;
}

function isGrantPrincipal(principal: ConnectionPrincipal | GrantPrincipal): principal is GrantPrincipal {
  return typeof (principal as GrantPrincipal).userId === 'string' && Array.isArray((principal as GrantPrincipal).roles);
}

function userIdOf(principal: ConnectionPrincipal | GrantPrincipal): string {
  return isGrantPrincipal(principal) ? principal.userId : principal.id;
}

/**
 * Grants: who besides the owner may use a connection. `assertCanUse` is
 * the check the resolver seam calls on every resolve-for-use;
 * `recordResolve` writes the audit row for it. list / grant / revoke
 * back the /connections/:id/grants endpoints.
 */
@Injectable()
export class GrantsService {
  /** Overridable clock so specs can drive cache expiry and grant expiry. */
  now: () => number = () => Date.now();

  private readonly cache = new Map<string, { at: number; grants: ConnectionGrant[] }>();

  constructor(
    @InjectRepository(ConnectionGrant) private readonly grants: Repository<ConnectionGrant>,
    @InjectRepository(Credential) private readonly credentials: Repository<Credential>,
    @InjectRepository(UserOrganization) private readonly memberships: Repository<UserOrganization>,
    @InjectRepository(UserTeam) private readonly userTeams: Repository<UserTeam>,
    @InjectRepository(Team) private readonly teams: Repository<Team>,
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    @InjectRepository(SpendBudget) private readonly budgets: Repository<SpendBudget>,
    private readonly auditLog: AuditLogService,
  ) {}

  // ------------------------------------------------------------------
  // Principals
  // ------------------------------------------------------------------

  /**
   * Build the grant principal for a request: org role and membership
   * permissions from the JWT user, team ids from the database, agent /
   * workspace from the run context. Uses `context.organizationId`,
   * else the request's current organization.
   */
  async principalFrom(req: { user?: RequestUserLike } | RequestUserLike, context: PrincipalContext = {}): Promise<GrantPrincipal> {
    const user = ((req as { user?: RequestUserLike }).user ?? req) as RequestUserLike;
    if (!user?.id) throw new BadRequestException({ code: 'NO_PRINCIPAL', message: 'a request user is required' });
    const organizationId = context.organizationId ?? user.currentOrganizationId;
    if (!organizationId) {
      throw new BadRequestException({ code: 'NO_ORGANIZATION', message: 'Organization context required. Multi-org users must send the X-Organization-Id header.' });
    }
    return this.principalFor(user, organizationId, context);
  }

  /** Same as `principalFrom` for a known organization. */
  async principalFor(user: ConnectionPrincipal, organizationId: string, context: GrantContext = {}): Promise<GrantPrincipal> {
    const membership = membershipOf(user, organizationId);
    const teamIds = membership ? await this.teamIdsOf(user.id, organizationId) : [];
    return {
      userId: user.id,
      roles: membership ? [String(membership.role)] : [],
      permissions: Array.isArray(membership?.permissions) ? [...membership!.permissions!] : [],
      teamIds,
      agentId: context.agentId,
      workspaceId: context.workspaceId,
    };
  }

  private async teamIdsOf(userId: string, organizationId: string): Promise<string[]> {
    const rows = await this.userTeams.find({ where: { userId, isActive: true } });
    if (!rows.length) return [];
    const orgTeams = await this.teams.find({ where: { organizationId, isActive: true } });
    const inOrg = new Set(orgTeams.map((team) => team.id));
    return rows.map((row) => row.teamId).filter((teamId) => inOrg.has(teamId));
  }

  // ------------------------------------------------------------------
  // The resolve seam
  // ------------------------------------------------------------------

  /**
   * Throws ConnectionNotGrantedError unless `principal` may use the
   * connection in `context`. Accepts the request user (memberships are
   * read, team ids loaded once) or a prebuilt GrantPrincipal. Returns
   * the decision so the caller can audit how access was reached.
   */
  async assertCanUse(principal: ConnectionPrincipal | GrantPrincipal, connection: ConnectionLike, context: UseContext = {}): Promise<GrantDecision> {
    const ctx = this.useContext(context);
    const who = isGrantPrincipal(principal) ? principal : await this.principalFor(principal, connection.organizationId, ctx);
    const grants = await this.grantsFor(connection.id);
    const decision = canUse(connection, who, grants, ctx);
    if (!decision.allowed) throw new ConnectionNotGrantedError(connection.id, decision.reason);
    return decision;
  }

  /** The CONNECTION_RESOLVE audit row: principal x connection x run. */
  async recordResolve(
    principal: ConnectionPrincipal | GrantPrincipal,
    connection: ConnectionLike & { name?: string; connectorKey?: string | null },
    context: UseContext = {},
    decision?: GrantDecision,
  ): Promise<void> {
    const ctx = this.useContext(context);
    const userId = userIdOf(principal);
    const agentId = ctx.agentId ?? (isGrantPrincipal(principal) ? principal.agentId : undefined) ?? null;
    const workspaceId = ctx.workspaceId ?? (isGrantPrincipal(principal) ? principal.workspaceId : undefined) ?? null;
    await this.auditLog.log({
      organizationId: connection.organizationId,
      userId,
      action: AuditAction.CONNECTION_RESOLVE,
      resourceType: AuditResource.CONNECTION,
      resourceId: connection.id,
      resourceName: connection.name,
      details: {
        principal: { userId, agentId, workspaceId },
        connectionId: connection.id,
        connectorKey: connection.connectorKey ?? null,
        owner: connection.ownerUserId ? 'user' : 'org',
        runId: ctx.runId ?? null,
        agentId,
        workspaceId,
        purpose: ctx.purpose ?? 'use',
        via: decision?.via ?? null,
        grantId: decision?.grant?.id ?? null,
      },
    });
  }

  /** A resolver context that names an agent or workspace as its resource implies that run context. */
  private useContext(context: UseContext): GrantContext & UseContext {
    const out: GrantContext & UseContext = { ...context };
    if (!out.agentId && context.resourceType === 'agent' && context.resourceId) out.agentId = context.resourceId;
    if (!out.workspaceId && context.resourceType === 'workspace' && context.resourceId) out.workspaceId = context.resourceId;
    if (!out.now) out.now = new Date(this.now());
    return out;
  }

  /** Grants of one connection, served from memory for GRANT_CACHE_TTL_MS. */
  async grantsFor(connectionId: string): Promise<ConnectionGrant[]> {
    const hit = this.cache.get(connectionId);
    const now = this.now();
    if (hit && now - hit.at < GRANT_CACHE_TTL_MS) return hit.grants;
    const grants = await this.grants.find({ where: { connectionId } });
    this.cache.set(connectionId, { at: now, grants });
    return grants;
  }

  invalidate(connectionId: string): void {
    this.cache.delete(connectionId);
  }

  // ------------------------------------------------------------------
  // Management
  // ------------------------------------------------------------------

  async list(connectionId: string, actor: ConnectionPrincipal, organizationId?: string): Promise<GrantView[]> {
    const connection = await this.loadConnection(connectionId, organizationId);
    const principal = await this.principalFor(actor, connection.organizationId);
    const grants = await this.grants.find({ where: { connectionId }, order: { createdAt: 'ASC' } });
    this.assertOversight(connection, principal, grants, 'list');
    return grants.map((grant) => this.view(grant));
  }

  /**
   * Add (or refresh) a grant. The actor must manage the connection: its
   * owner for a user-scoped one, `connections:manage` or a manage grant
   * for an org-scoped one. Without `connections:manage` an actor may
   * only bind a connection to agents and workspaces they own.
   */
  async grant(connectionId: string, input: GrantInput, actor: ConnectionPrincipal, organizationId?: string): Promise<GrantView> {
    const connection = await this.loadConnection(connectionId, organizationId);
    const principal = await this.principalFor(actor, connection.organizationId);
    const existing = await this.grants.find({ where: { connectionId } });
    const decision = canManage(connection, principal, existing, { now: new Date(this.now()) });
    if (!decision.allowed) throw new ForbiddenException({ code: 'CONNECTION_GRANT_FORBIDDEN', message: decision.reason });

    const principalType = input.principalType;
    if (!GRANT_PRINCIPAL_TYPES.includes(principalType)) {
      throw new BadRequestException({ code: 'GRANT_PRINCIPAL_INVALID', message: `principalType must be one of ${GRANT_PRINCIPAL_TYPES.join(', ')}` });
    }
    const permission = input.permission ?? 'use';
    if (!GRANT_PERMISSIONS.includes(permission)) {
      throw new BadRequestException({ code: 'GRANT_PERMISSION_INVALID', message: `permission must be one of ${GRANT_PERMISSIONS.join(', ')}` });
    }
    const expiresAt = this.parseExpiry(input.expiresAt);
    const principalId = await this.checkTarget(connection, principal, principalType, String(input.principalId ?? ''));
    const budgetId = await this.checkBudget(connection.organizationId, input.budgetId);

    let row = existing.find((grant) => grant.principalType === principalType && grant.principalId === principalId);
    const refreshed = !!row;
    if (!row) {
      row = this.grants.create({ organizationId: connection.organizationId, connectionId: connection.id, principalType, principalId });
    }
    row.permission = permission;
    row.budgetId = budgetId;
    row.expiresAt = expiresAt;
    row.grantedBy = actor.id;
    row = await this.grants.save(row);
    this.invalidate(connection.id);

    await this.auditLog.log({
      organizationId: connection.organizationId,
      userId: actor.id,
      action: AuditAction.CONNECTION_GRANT,
      resourceType: AuditResource.CONNECTION,
      resourceId: connection.id,
      resourceName: connection.name,
      details: {
        grantId: row.id, principalType, principalId, permission, budgetId, expiresAt, refreshed,
        owner: connection.ownerUserId ? 'user' : 'org', via: decision.via ?? null,
      },
    });
    return this.view(row);
  }

  /**
   * The sane default for an organization connection: every member may
   * use it, until an admin narrows that. Written by the connect flow, not
   * by a user, so no manage check; audited as a grant with default: true.
   * Skipped when a grant for the member role already exists.
   */
  async grantDefaultForOrgConnection(connection: ConnectionLike & { id: string; organizationId: string; name?: string; ownerUserId?: string | null }, grantedBy: string | null): Promise<GrantView | null> {
    if (connection.ownerUserId) return null;
    const existing = await this.grants.find({ where: { connectionId: connection.id } });
    if (existing.some((grant) => grant.principalType === 'role' && grant.principalId === 'member')) return null;
    let row = this.grants.create({ organizationId: connection.organizationId, connectionId: connection.id, principalType: 'role', principalId: 'member' });
    row.permission = 'use';
    row.budgetId = null;
    row.expiresAt = null;
    row.grantedBy = grantedBy;
    row = await this.grants.save(row);
    this.invalidate(connection.id);
    await this.auditLog.log({
      organizationId: connection.organizationId,
      userId: grantedBy ?? undefined,
      action: AuditAction.CONNECTION_GRANT,
      resourceType: AuditResource.CONNECTION,
      resourceId: connection.id,
      resourceName: connection.name,
      details: { grantId: row.id, principalType: 'role', principalId: 'member', permission: 'use', default: true, owner: 'org' },
    });
    return this.view(row);
  }

  /**
   * Remove a grant. Same authorisation as `grant`, plus
   * `connections:manage` may revoke (but never add) grants on a
   * user-scoped connection so an admin can stop sharing without being
   * able to hand out someone's secret.
   */
  async revoke(grantId: string, actor: ConnectionPrincipal, organizationId?: string): Promise<GrantView> {
    const row = await this.grants.findOne({ where: { id: grantId } });
    if (!row || (organizationId && row.organizationId !== organizationId)) {
      throw new NotFoundException({ code: 'GRANT_NOT_FOUND', message: 'grant not found' });
    }
    const connection = await this.loadConnection(row.connectionId, organizationId);
    const principal = await this.principalFor(actor, connection.organizationId);
    const grants = await this.grants.find({ where: { connectionId: connection.id } });
    const decision = this.assertOversight(connection, principal, grants, 'revoke');

    await this.grants.remove(row);
    this.invalidate(connection.id);
    await this.auditLog.log({
      organizationId: connection.organizationId,
      userId: actor.id,
      action: AuditAction.CONNECTION_REVOKE_GRANT,
      resourceType: AuditResource.CONNECTION,
      resourceId: connection.id,
      resourceName: connection.name,
      details: {
        grantId: row.id, principalType: row.principalType, principalId: row.principalId, permission: row.permission,
        owner: connection.ownerUserId ? 'user' : 'org', via: decision.via ?? null,
      },
    });
    return this.view({ ...row, id: grantId });
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** canManage, or the admin oversight exception for list / revoke on user-scoped connections. */
  private assertOversight(connection: Credential, principal: GrantPrincipal, grants: ConnectionGrant[], what: 'list' | 'revoke'): GrantDecision {
    const decision = canManage(connection, principal, grants, { now: new Date(this.now()) });
    if (decision.allowed) return decision;
    if (connection.ownerUserId && hasManagePermission(principal)) {
      return { allowed: true, reason: `connections:manage may ${what} grants on a user-scoped connection`, via: 'connections:manage' };
    }
    throw new ForbiddenException({ code: 'CONNECTION_GRANT_FORBIDDEN', message: decision.reason });
  }

  private async loadConnection(connectionId: string, organizationId?: string): Promise<Credential> {
    const row = await this.credentials.findOne({ where: { id: connectionId } });
    if (!row || !row.connectorKey || (organizationId && row.organizationId !== organizationId)) {
      throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND', message: 'connection not found' });
    }
    return row;
  }

  private parseExpiry(value: GrantInput['expiresAt']): Date | null {
    if (value === undefined || value === null || value === '') return null;
    const at = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(at.getTime())) throw new BadRequestException({ code: 'GRANT_EXPIRES_INVALID', message: 'expiresAt must be an ISO 8601 date' });
    if (at.getTime() <= this.now()) throw new BadRequestException({ code: 'GRANT_EXPIRES_IN_PAST', message: 'expiresAt must be in the future' });
    return at;
  }

  private async checkBudget(organizationId: string, budgetId: string | null | undefined): Promise<string | null> {
    if (!budgetId) return null;
    const budget = await this.budgets.findOne({ where: { id: budgetId, organizationId } });
    if (!budget) throw new NotFoundException({ code: 'GRANT_BUDGET_NOT_FOUND', message: 'budget not found in this organization' });
    return budget.id;
  }

  /**
   * The grant target must exist in the connection's organization. Agents
   * and workspaces are further restricted to ones the actor owns unless
   * the actor holds `connections:manage`.
   */
  private async checkTarget(connection: Credential, actor: GrantPrincipal, type: GrantPrincipalType, principalId: string): Promise<string> {
    const organizationId = connection.organizationId;
    if (type === 'role') {
      const roles = Object.values(OrganizationRole) as string[];
      if (!roles.includes(principalId)) {
        throw new BadRequestException({ code: 'GRANT_PRINCIPAL_INVALID', message: `role must be one of ${roles.join(', ')}` });
      }
      return principalId;
    }
    if (!UUID_RE.test(principalId)) {
      throw new BadRequestException({ code: 'GRANT_PRINCIPAL_INVALID', message: `${type} principalId must be a uuid` });
    }
    const missing = (what: string) => new NotFoundException({ code: 'GRANT_PRINCIPAL_NOT_FOUND', message: `${what} not found in this organization` });
    switch (type) {
      case 'user': {
        const membership = await this.memberships.findOne({ where: { userId: principalId, organizationId, isActive: true } });
        if (!membership) throw missing('user');
        return principalId;
      }
      case 'team': {
        const team = await this.teams.findOne({ where: { id: principalId, organizationId } });
        if (!team) throw missing('team');
        return principalId;
      }
      case 'agent': {
        const agent = await this.agents.findOne({ where: { id: principalId, organizationId } });
        if (!agent) throw missing('agent');
        if (!hasManagePermission(actor) && agent.createdBy !== actor.userId) {
          throw new ForbiddenException({ code: 'GRANT_AGENT_NOT_OWNED', message: 'without connections:manage you can only grant connections to agents you created' });
        }
        return principalId;
      }
      case 'workspace': {
        const workspace = await this.workspaces.findOne({ where: { id: principalId, organizationId } });
        if (!workspace) throw missing('workspace');
        if (!hasManagePermission(actor) && workspace.ownerUserId !== actor.userId) {
          throw new ForbiddenException({ code: 'GRANT_WORKSPACE_NOT_OWNED', message: 'without connections:manage you can only grant connections to workspaces you own' });
        }
        return principalId;
      }
      default:
        throw new BadRequestException({ code: 'GRANT_PRINCIPAL_INVALID', message: 'unknown principal type' });
    }
  }

  view(grant: ConnectionGrant): GrantView {
    return {
      id: grant.id,
      connectionId: grant.connectionId,
      principalType: grant.principalType,
      principalId: grant.principalId,
      permission: grant.permission,
      budgetId: grant.budgetId ?? null,
      grantedBy: grant.grantedBy ?? null,
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt ?? null,
      expired: isExpired(grant, new Date(this.now())),
    };
  }
}
