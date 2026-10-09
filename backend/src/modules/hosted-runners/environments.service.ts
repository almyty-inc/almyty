import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Environment } from '../../entities/environment.entity';
import { Credential } from '../../entities/credential.entity';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AccessPolicyService, ResourceVisibility, normaliseVisibility } from '../../common/authorization/access-policy.service';
import { assertManageable } from '../../common/authorization/read-rule';
import { nameTaken } from '../../common/authorization/private-visibility';
import { isUniqueViolation } from '../../common/utils/unique-violation';
import { EE_ENTITLEMENTS } from '../licensing/license.constants';
import { OrgLicenseResolver } from '../licensing/org-license.resolver';
import { isAllowlistHost } from './adapters/kubernetes/manifests';
import { HostedRunnerSettingsService } from './hosted-runner-settings';
import { HostedRunnersService } from './hosted-runners.service';
import { RunnerCapabilityPublisher } from '../runner/runner-capability.publisher';
import { CreateEnvironmentDto, UpdateEnvironmentDto } from './dto/environment.dto';

/** What a save hears when it shares an environment without the plan. */
export const SHARED_ENVIRONMENTS_NOT_INCLUDED =
  'Sharing an environment with a team or the whole organization is part of the Business plan. Keep it private, or upgrade.';

/** Fields whose change makes a new environment version (a pod started after it runs the new one). */
const VERSIONED_FIELDS = ['repo', 'image', 'setupScript', 'envBindings', 'cache', 'egress', 'resourceClass', 'allowVendorKeys'] as const;

/**
 * Environments: create, read, change and delete, with the access policy
 * on every read and the plan gate on the visibility write.
 *
 * Visibility is the same three tiers as every other resource. Sharing
 * (team or org) is the `hosted_shared_environments` entitlement; a
 * private environment is any plan that has hosted runners. The gate sits
 * on the write only (Frane, decision 4): a list filter or a read never
 * asks the plan, so a downgrade leaves existing shared environments
 * readable by those they were shared with and only refuses widening.
 */
@Injectable()
export class EnvironmentsService {
  constructor(
    @InjectRepository(Environment) private readonly environments: Repository<Environment>,
    @InjectRepository(Credential) private readonly credentials: Repository<Credential>,
    private readonly accessPolicy: AccessPolicyService,
    private readonly settings: HostedRunnerSettingsService,
    private readonly hosted: HostedRunnersService,
    private readonly capabilities: RunnerCapabilityPublisher,
    @Optional() private readonly licenses?: OrgLicenseResolver,
    @Optional() private readonly auditLog?: AuditLogService,
  ) {}

  async list(userId: string, organizationId: string): Promise<Environment[]> {
    const qb = this.environments.createQueryBuilder('e');
    await this.accessPolicy.applyListFilter(qb, { id: userId }, organizationId, 'e', { ownerColumn: 'ownerUserId' });
    return qb.orderBy('e."createdAt"', 'DESC').getMany();
  }

  async get(id: string, userId: string, organizationId: string): Promise<Environment> {
    const env = await this.environments.findOne({ where: { id, organizationId } });
    if (!env || !(await this.accessPolicy.canAccess({ id: userId }, env, 'read')).allowed) throw new NotFoundException('environment not found');
    return env;
  }

  async create(dto: CreateEnvironmentDto, userId: string, organizationId: string): Promise<Environment> {
    this.hosted.refuseWhenDisabled();
    const scope = normaliseVisibility(dto.visibility ?? 'private', dto.teamId);
    await this.assertMayShare(organizationId, scope.visibility);
    await this.accessPolicy.assertCanScopeToTeam(userId, organizationId, scope.visibility, scope.teamId);
    const fields = await this.validated(dto, userId, organizationId, null);
    const row = this.environments.create({
      organizationId,
      ownerUserId: userId,
      visibility: scope.visibility,
      teamId: scope.teamId,
      name: dto.name,
      description: dto.description ?? null,
      version: 1,
      clusterConnectionId: null,
      ...fields,
    } as Partial<Environment>);
    let saved: Environment;
    try {
      saved = await this.environments.save(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken('environment', dto.name);
      throw err;
    }
    // Its tools: `env.<name>.<method>`, as visible as the environment.
    try {
      await this.capabilities.publishEnvironment(saved);
    } catch (err) {
      // No environment without its tools (a full tool quota, say).
      await this.environments.delete({ id: saved.id });
      throw err;
    }
    this.audit(saved, AuditAction.ENVIRONMENT_CREATED, userId, { visibility: saved.visibility, resourceClass: saved.resourceClass });
    return saved;
  }

  async update(id: string, dto: UpdateEnvironmentDto, userId: string, organizationId: string): Promise<Environment> {
    this.hosted.refuseWhenDisabled();
    const env = await this.loadManageable(id, userId, organizationId);
    const before = { ...env };
    if (dto.visibility !== undefined) {
      const scope = normaliseVisibility(dto.visibility, dto.teamId);
      // Widening is the gated write; keeping or narrowing never is.
      if (scope.visibility !== env.visibility || scope.teamId !== env.teamId) await this.assertMayShare(organizationId, scope.visibility);
      await this.accessPolicy.assertCanScopeToTeam(userId, organizationId, scope.visibility, scope.teamId);
      env.visibility = scope.visibility;
      env.teamId = scope.teamId;
    }
    if (dto.name !== undefined) env.name = dto.name;
    if (dto.description !== undefined) env.description = dto.description ?? null;
    const fields = await this.validated(dto, userId, organizationId, env);
    Object.assign(env, fields);
    const changed = VERSIONED_FIELDS.filter((k) => JSON.stringify((before as any)[k]) !== JSON.stringify((env as any)[k]));
    if (changed.length > 0) env.version = (env.version ?? 1) + 1;
    let saved: Environment;
    try {
      saved = await this.environments.save(env);
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken('environment', env.name);
      throw err;
    }
    // Its tools carry its name and visibility.
    if (before.name !== saved.name || before.visibility !== saved.visibility || before.teamId !== saved.teamId) await this.capabilities.publishEnvironment(saved);
    this.audit(saved, AuditAction.ENVIRONMENT_UPDATED, userId, {
      changed: [...changed, ...(before.visibility !== saved.visibility ? ['visibility'] : []), ...(before.name !== saved.name ? ['name'] : [])],
      version: saved.version,
    });
    return saved;
  }

  /** Soft delete; every machine of the environment is torn down, volumes included. */
  async remove(id: string, userId: string, organizationId: string): Promise<void> {
    const env = await this.loadManageable(id, userId, organizationId);
    await this.environments.softDelete({ id: env.id, organizationId });
    await this.hosted.teardownEnvironment(env.id, userId);
    await this.capabilities.unpublishEnvironment(env.id);
    this.audit(env, AuditAction.ENVIRONMENT_DELETED, userId, {});
  }

  private async loadManageable(id: string, userId: string, organizationId: string): Promise<Environment> {
    const env = await this.environments.findOne({ where: { id, organizationId } });
    return assertManageable(this.accessPolicy, userId, env, 'environment', { ownerManages: true });
  }

  /** Team or org visibility needs the plan; private never does. */
  private async assertMayShare(organizationId: string, visibility: ResourceVisibility): Promise<void> {
    if (visibility === 'private') return;
    const licensed = this.licenses
      ? await this.licenses.hasForOrg(organizationId, EE_ENTITLEMENTS.HOSTED_SHARED_ENVIRONMENTS).catch(() => false)
      : false;
    if (!licensed) throw new ForbiddenException({ code: 'ENTITLEMENT_REQUIRED', entitlement: EE_ENTITLEMENTS.HOSTED_SHARED_ENVIRONMENTS, message: SHARED_ENVIRONMENTS_NOT_INCLUDED });
  }

  /**
   * The configuration fields of a create or update, checked against the
   * install's settings and the organization's capacity. `current` is the
   * row being updated (its values stand where the dto says nothing).
   */
  private async validated(dto: CreateEnvironmentDto | UpdateEnvironmentDto, userId: string, organizationId: string, current: Environment | null): Promise<Partial<Environment>> {
    const s = this.settings.current;
    const out: Partial<Environment> = {};

    if (dto.clusterConnectionId) {
      throw new BadRequestException({ code: 'CLUSTER_CONNECTION_NOT_OFFERED', message: 'Running an environment on your own cluster is not offered yet; leave clusterConnectionId empty' });
    }

    if (dto.image !== undefined || !current) {
      const base = dto.image?.base;
      const ref = base ? s.images[base] : undefined;
      if (!base || !ref) {
        throw new BadRequestException({ code: 'IMAGE_UNKNOWN', message: `image.base must be one of: ${Object.keys(s.images).join(', ')}` });
      }
      out.image = { base, ref };
    }

    if (dto.resourceClass !== undefined || !current) {
      const name = dto.resourceClass ?? s.defaultResourceClass;
      if (!s.resourceClasses[name]) {
        throw new BadRequestException({ code: 'RESOURCE_CLASS_UNKNOWN', message: `resourceClass must be one of: ${Object.keys(s.resourceClasses).join(', ')}` });
      }
      const capacity = await this.hosted.capacityFor(organizationId);
      if (capacity.resourceClasses && !capacity.resourceClasses.includes(name)) {
        throw new BadRequestException({ code: 'RESOURCE_CLASS_NOT_INCLUDED', message: `Your plan includes these sizes: ${capacity.resourceClasses.join(', ')}` });
      }
      out.resourceClass = name;
    }

    if (dto.idleTimeoutMinutes !== undefined || !current) {
      const { min, max, default: fallback } = s.idleTimeoutMinutes;
      const minutes = dto.idleTimeoutMinutes ?? fallback;
      if (!Number.isInteger(minutes) || minutes < min || minutes > max) {
        throw new BadRequestException({ code: 'IDLE_TIMEOUT_OUT_OF_RANGE', message: `idleTimeoutMinutes must be between ${min} and ${max}` });
      }
      out.idleTimeoutMinutes = minutes;
    }

    if (dto.egress !== undefined || !current) {
      const allowHosts = [...new Set((dto.egress?.allowHosts ?? []).map((h) => h.trim()))];
      const bad = allowHosts.filter((h) => !isAllowlistHost(h));
      if (bad.length) {
        throw new BadRequestException({
          code: 'EGRESS_HOST_INVALID',
          message: `These cannot be allowed: ${bad.join(', ')}. Name each host exactly, in lower case (github.com, registry.npmjs.org); no wildcards, addresses or internal names.`,
        });
      }
      out.egress = { allowHosts, ...(dto.egress?.allowBinaries?.length ? { allowBinaries: [...new Set(dto.egress.allowBinaries)] } : {}) };
    }

    if (dto.cache !== undefined || !current) {
      const paths = dto.cache?.paths ?? [];
      const mount = s.cluster.workspaceMountPath;
      const outside = paths.filter((p) => !p.startsWith(`${mount}/`) || p.includes('..'));
      if (outside.length) throw new BadRequestException({ code: 'CACHE_PATH_INVALID', message: `Cache paths must be inside ${mount}: ${outside.join(', ')}` });
      out.cache = { paths };
    }

    if (dto.repo !== undefined) {
      if (dto.repo?.connectionId) await this.assertUsableConnection(dto.repo.connectionId, userId, organizationId);
      out.repo = dto.repo ? { url: dto.repo.url, ref: dto.repo.ref ?? null, connectionId: dto.repo.connectionId ?? null } : null;
    } else if (!current) {
      out.repo = null;
    }

    if (dto.envBindings !== undefined || !current) {
      const bindings = dto.envBindings ?? [];
      const vars = bindings.map((b) => b.envVar);
      const dup = vars.filter((v, i) => vars.indexOf(v) !== i);
      if (dup.length) throw new BadRequestException({ code: 'ENV_VAR_DUPLICATE', message: `Each variable may be set once: ${[...new Set(dup)].join(', ')}` });
      for (const b of bindings) await this.assertUsableConnection(b.connectionId, userId, organizationId);
      out.envBindings = bindings.map((b) => ({ connectionId: b.connectionId, field: b.field, envVar: b.envVar }));
    }

    // A model provider's own key goes into pods only where the environment
    // allows it (Decision 6 (b)); off unless someone turns it on.
    if (dto.allowVendorKeys !== undefined || !current) out.allowVendorKeys = dto.allowVendorKeys ?? false;
    if (dto.envBindings !== undefined || dto.allowVendorKeys !== undefined) {
      try {
        await this.hosted.assertNoVendorKeys({
          organizationId,
          allowVendorKeys: out.allowVendorKeys ?? current?.allowVendorKeys ?? false,
          envBindings: out.envBindings ?? current?.envBindings ?? [],
        });
      } catch (err: any) {
        if (err?.code !== 'VENDOR_KEY_NOT_ALLOWED') throw err;
        throw new BadRequestException({ code: 'VENDOR_KEY_NOT_ALLOWED', message: err.message, connectionIds: err.connectionIds });
      }
    }

    if (dto.setupScript !== undefined) out.setupScript = dto.setupScript ?? null;
    else if (!current) out.setupScript = null;
    return out;
  }

  /** A connection the saver may use, in this organization. The value is never read here. */
  private async assertUsableConnection(connectionId: string, userId: string, organizationId: string): Promise<void> {
    const credential = await this.credentials.findOne({ where: { id: connectionId, organizationId } });
    if (!credential || !(await this.accessPolicy.canAccess({ id: userId }, credential as any, 'use')).allowed) {
      throw new BadRequestException({ code: 'CONNECTION_NOT_FOUND', message: `Connection ${connectionId} was not found or is not yours to use` });
    }
  }

  private audit(env: Environment, action: AuditAction, userId: string, details: Record<string, any>): void {
    void this.auditLog
      ?.log({
        organizationId: env.organizationId,
        userId,
        action,
        resourceType: AuditResource.ENVIRONMENT,
        resourceId: env.id,
        resourceName: env.name,
        details,
      })
      .catch(() => undefined);
  }
}
