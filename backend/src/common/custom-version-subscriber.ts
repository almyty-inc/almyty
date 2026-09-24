import {
  DataSource,
  EventSubscriber,
  EntitySubscriberInterface,
  InsertEvent,
  UpdateEvent,
  RemoveEvent,
} from 'typeorm';
import { instanceToPlain } from 'class-transformer';
import {
  isVersionedEntity,
  isVersioningSkipped,
  Version,
  VersionEvent,
} from 'typeorm-versions';
import { getVersionOwner } from './version-context';
import { redactVersionSnapshot } from './version-snapshot-redaction';

/**
 * typeorm-versions' own saveVersion, with one difference: the snapshot is
 * redacted before it is written. The library serializes the entity as is,
 * so every secret a credential (or a provider, or a gateway) ever held
 * stayed in the `version` table after it was rotated away.
 */
export async function saveRedactedVersion(
  connection: DataSource,
  entity: any,
  event: VersionEvent,
  owner?: string,
): Promise<Version | undefined> {
  const metadata = connection.getMetadata(entity.constructor);
  const itemId = metadata.primaryColumns.map((column) => column.getEntityValue(entity)).join('/');
  if (!itemId) return undefined;
  (Version as any).useDataSource?.(connection);
  const version = new Version();
  version.event = event;
  version.owner = owner || 'system';
  version.object = redactVersionSnapshot(instanceToPlain(entity));
  version.itemId = itemId;
  version.itemType = entity.constructor.name;
  version.timestamp = new Date();
  return connection.getRepository(Version).save(version);
}

@EventSubscriber()
export class CustomVersionSubscriber implements EntitySubscriberInterface {
  async afterInsert(event: InsertEvent<any>) {
    if (isVersioningSkipped(event.queryRunner?.data)) return;
    if (isVersionedEntity(event.entity)) {
      await saveRedactedVersion(event.connection, event.entity, VersionEvent.INSERT, getVersionOwner());
    }
  }

  async afterUpdate(event: UpdateEvent<any>) {
    if (isVersioningSkipped(event.queryRunner?.data)) return;
    if (event.entity && isVersionedEntity(event.entity)) {
      await saveRedactedVersion(event.connection, event.entity, VersionEvent.UPDATE, getVersionOwner());
    }
  }

  async beforeRemove(event: RemoveEvent<any>) {
    if (isVersioningSkipped(event.queryRunner?.data)) return;
    if (event.entity && isVersionedEntity(event.entity)) {
      await saveRedactedVersion(event.connection, event.entity, VersionEvent.REMOVE, getVersionOwner());
    }
  }
}
