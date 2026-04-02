import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Version } from 'typeorm-versions';

@Injectable()
export class VersionsService {
  constructor(private dataSource: DataSource) {}

  async getVersions(entityType: string, entityId: string): Promise<Version[]> {
    return this.dataSource.getRepository(Version).find({
      where: { itemType: entityType, itemId: entityId },
      order: { timestamp: 'DESC' },
    });
  }

  async getVersion(versionId: number): Promise<Version | null> {
    return this.dataSource.getRepository(Version).findOne({ where: { id: versionId } });
  }

  async rollback(entityType: string, entityId: string, versionId: number): Promise<any> {
    const version = await this.dataSource.getRepository(Version).findOne({ where: { id: versionId } });
    if (!version) throw new Error('Version not found');
    return version.object;
  }

  /**
   * Sets the owner on the most recent version for a given entity.
   * Called after entity saves to attach user identity to the auto-created version.
   * Only updates if the current owner is 'system' (i.e., set by the subscriber default).
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
