import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { Version } from 'typeorm-versions';

import { Gateway } from '../../entities/gateway.entity';
import { Tool } from '../../entities/tool.entity';
import { Credential } from '../../entities/credential.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { Agent } from '../../entities/agent.entity';

/**
 * Map of supported entity types (from typeorm-versions `itemType`) to
 * the TypeORM entity class they correspond to. Every entity in this
 * list MUST have an `organizationId` column so we can scope version
 * reads to the caller's org.
 *
 * Previously VersionsService exposed `getVersions()`, `getVersion()`,
 * and `rollback()` without any org check at all — any authenticated
 * user could read another org's gateway/credential/tool/provider
 * snapshots just by knowing the entity id, or by enumerating
 * sequential version ids via `getVersion(1)`, `getVersion(2)`, etc.
 * Since version snapshots are the full entity JSON at save time, that
 * included encrypted credential config, tool configurations, and
 * gateway auth settings from every other org.
 */
const SUPPORTED_ENTITIES: Record<string, new () => any> = {
  Gateway,
  Tool,
  Credential,
  LlmProvider,
  Agent,
};

/** Page size used when the caller does not ask for one. */
export const DEFAULT_VERSION_PAGE_SIZE = 50;
/** Hard ceiling on a single page of version snapshots. */
export const MAX_VERSION_PAGE_SIZE = 200;

@Injectable()
export class VersionsService {
  constructor(private dataSource: DataSource) {}

  private async assertEntityBelongsToOrg(
    entityType: string,
    entityId: string,
    organizationId: string,
  ): Promise<void> {
    const entityClass = SUPPORTED_ENTITIES[entityType];
    if (!entityClass) {
      throw new BadRequestException(`Unsupported entity type: ${entityType}`);
    }
    const repo: Repository<any> = this.dataSource.getRepository(entityClass);
    const entity = await repo.findOne({ where: { id: entityId } as any });
    if (!entity) {
      throw new NotFoundException(`${entityType} not found`);
    }
    if (entity.organizationId !== organizationId) {
      // Deliberately return "not found" rather than "forbidden" so this
      // endpoint can't be used to probe for the existence of entity ids
      // in other organizations.
      throw new NotFoundException(`${entityType} not found`);
    }
  }

  /**
   * The `version` table is one of the fastest-growing in the schema — the
   * version subscriber writes a full serialized entity on every save of a
   * @VersionedEntity, and the model reconcile loop saves several per
   * deployment every couple of minutes. Returning every snapshot an entity
   * has ever had makes the response size scale with tenant age rather than
   * with anything the caller asked for, so this is paged with the same
   * ceiling convention the audit log uses (`Math.min(limit ?? 50, 200)`).
   *
   * `object` stays in the projection: the Change History view diffs each
   * snapshot against the one below it, so metadata alone is not enough.
   */
  async getVersions(
    entityType: string,
    entityId: string,
    organizationId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Version[]> {
    await this.assertEntityBelongsToOrg(entityType, entityId, organizationId);
    const take = Math.min(
      Number.isFinite(options.limit as number) && (options.limit as number) > 0
        ? (options.limit as number)
        : DEFAULT_VERSION_PAGE_SIZE,
      MAX_VERSION_PAGE_SIZE,
    );
    const skip =
      Number.isFinite(options.offset as number) && (options.offset as number) > 0
        ? Math.floor(options.offset as number)
        : 0;
    return this.dataSource.getRepository(Version).find({
      where: { itemType: entityType, itemId: entityId },
      order: { timestamp: 'DESC' },
      skip,
      take,
    });
  }

  async getVersion(
    versionId: number,
    organizationId: string,
  ): Promise<Version | null> {
    const version = await this.dataSource
      .getRepository(Version)
      .findOne({ where: { id: versionId } });
    if (!version) return null;

    // Look up the entity this version belongs to in the current DB
    // (we do NOT trust the snapshot's own organizationId) and verify
    // the caller's membership.
    await this.assertEntityBelongsToOrg(version.itemType, version.itemId, organizationId);
    return version;
  }

  async rollback(
    entityType: string,
    entityId: string,
    versionId: number,
    organizationId: string,
  ): Promise<any> {
    await this.assertEntityBelongsToOrg(entityType, entityId, organizationId);
    const version = await this.dataSource
      .getRepository(Version)
      .findOne({ where: { id: versionId } });
    if (!version) throw new NotFoundException('Version not found');
    if (version.itemType !== entityType || version.itemId !== entityId) {
      throw new ForbiddenException('Version does not belong to the requested entity');
    }
    return version.object;
  }

  /**
   * Sets the owner on the most recent version for a given entity.
   * Called after entity saves to attach user identity to the auto-created version.
   * Only updates if the current owner is 'system' (i.e., set by the subscriber default).
   *
   * Internal helper — no org check because callers are already trusted
   * (e.g. the entity's own save hook).
   */
  async setOwner(entityType: string, entityId: string, owner: string): Promise<void> {
    const versionRepo = this.dataSource.getRepository(Version);
    const latest = await versionRepo.findOne({
      where: { itemType: entityType, itemId: entityId },
      order: { timestamp: 'DESC' },
    });
    if (latest && latest.owner === 'system') {
      latest.owner = owner;
      await versionRepo.save(latest);
    }
  }
}
