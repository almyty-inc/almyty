import { ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';

import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ConnectorCatalogService } from './connector-catalog.service';
import { ConnectionView, ConnectorDefinition } from './connector.types';
import { ConnectionsService } from './connections.service';
import { CONNECTIONS_READ, ConnectionPrincipal, membershipOf, principalHasPermission } from './connections.permissions';
import { GrantsService } from './grants/grants.service';

export interface ResolvedConnection {
  connection: ConnectionView;
  connector: ConnectorDefinition;
  /** Decrypted config: the only place a connection's secret is handed to a consumer. Never serialize it. */
  config: Record<string, any>;
}

export interface ResolveContext {
  /** What the secret is for; lands in the audit event. */
  purpose: string;
  resourceType?: string;
  resourceId?: string;
}

/**
 * The seam every consumer goes through to use a connection (gate 3
 * switches LLM providers, deployment adapters, memory backends and MCP
 * sources onto it). Gate 1 checks ownership: an org connection resolves
 * for any member with connections:read, a user connection only for its
 * owner. Gate 2 adds grants (workspace, agent, team) inside
 * `resolveForUse` without changing its signature.
 */
@Injectable()
export class ConnectionsResolverService {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly catalog: ConnectorCatalogService,
    private readonly auditLog: AuditLogService,
    @Optional() private readonly grants?: GrantsService,
  ) {}

  async resolveForUse(principal: ConnectionPrincipal, connectionId: string, context: ResolveContext = { purpose: 'use' }): Promise<ResolvedConnection> {
    const row = await this.connections.loadForResolve(connectionId);
    if (!row) throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND', message: 'connection not found' });
    if (!membershipOf(principal, row.organizationId)) {
      throw new ForbiddenException({ code: 'CONNECTION_FORBIDDEN', message: 'not a member of the connection owner organization' });
    }

    if (this.grants) {
      // Gate 2: owner, connections:manage on an org connection, or a
      // matching grant (user, team, role, agent, workspace). Throws
      // CONNECTION_NOT_GRANTED with the reason.
      const decision = await this.grants.assertCanUse(principal, row, context);
      const resolved = await this.materialize(row.id, row.organizationId, principal.id, context, true);
      await this.grants.recordResolve(principal, row, context, decision);
      return resolved;
    }

    // Ownership only (no grants module wired): org connections for any
    // member with connections:read, user connections for their owner.
    const allowed = row.ownerUserId
      ? row.ownerUserId === principal.id
      : principalHasPermission(principal, row.organizationId, CONNECTIONS_READ);
    if (!allowed) throw new ForbiddenException({ code: 'CONNECTION_FORBIDDEN', message: 'not your connection' });

    return this.materialize(row.id, row.organizationId, principal.id, context);
  }

  /**
   * System path for jobs that run without a user (schedulers, reconcile
   * loops): org-owned connections only, audited with the caller's stated
   * actor. User-owned connections need a principal (or, in gate 2, a grant).
   */
  async resolveForOrg(organizationId: string, connectionId: string, context: ResolveContext & { actorUserId?: string }): Promise<ResolvedConnection> {
    const row = await this.connections.loadForResolve(connectionId);
    if (!row || row.organizationId !== organizationId) throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND', message: 'connection not found' });
    if (row.ownerUserId && row.ownerUserId !== context.actorUserId) {
      throw new ForbiddenException({ code: 'CONNECTION_FORBIDDEN', message: 'a user-owned connection cannot be used by the organization' });
    }
    return this.materialize(row.id, organizationId, context.actorUserId, context);
  }

  private async materialize(connectionId: string, organizationId: string, userId: string | undefined, context: ResolveContext, audited = false): Promise<ResolvedConnection> {
    const row = (await this.connections.loadForResolve(connectionId))!;
    if (!row.isActive) throw new ForbiddenException({ code: 'CONNECTION_INACTIVE', message: 'connection is inactive' });
    const connector = await this.catalog.require(organizationId, row.connectorKey!);
    const config = await this.connections.decryptConfig(row);
    // With grants wired the resolve row is written by GrantsService.recordResolve (it carries the grant used).
    if (!audited) this.auditLog.log({
      organizationId, userId, action: AuditAction.CONNECTION_RESOLVE, resourceType: AuditResource.CONNECTION,
      resourceId: row.id, resourceName: row.name,
      details: { connectorKey: row.connectorKey, owner: row.ownerUserId ? 'user' : 'org', purpose: context.purpose, resourceType: context.resourceType ?? null, resourceId: context.resourceId ?? null, health: row.healthStatus },
    });
    return { connection: this.connections.view(row, connector), connector, config };
  }
}
