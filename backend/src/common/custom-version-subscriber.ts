import {
  EventSubscriber,
  EntitySubscriberInterface,
  InsertEvent,
  UpdateEvent,
  RemoveEvent,
} from 'typeorm';
import {
  isVersionedEntity,
  isVersioningSkipped,
  VersionRepository,
  VersionEvent,
} from 'typeorm-versions';
import { getVersionOwner } from './version-context';

@EventSubscriber()
export class CustomVersionSubscriber implements EntitySubscriberInterface {
  async afterInsert(event: InsertEvent<any>) {
    if (isVersioningSkipped(event.queryRunner?.data)) return;
    if (isVersionedEntity(event.entity)) {
      await VersionRepository(event.connection as any).saveVersion(
        event.entity,
        VersionEvent.INSERT,
        getVersionOwner(),
      );
    }
  }

  async afterUpdate(event: UpdateEvent<any>) {
    if (isVersioningSkipped(event.queryRunner?.data)) return;
    if (event.entity && isVersionedEntity(event.entity)) {
      await VersionRepository(event.connection as any).saveVersion(
        event.entity,
        VersionEvent.UPDATE,
        getVersionOwner(),
      );
    }
  }

  async beforeRemove(event: RemoveEvent<any>) {
    if (isVersioningSkipped(event.queryRunner?.data)) return;
    if (event.entity && isVersionedEntity(event.entity)) {
      await VersionRepository(event.connection as any).saveVersion(
        event.entity,
        VersionEvent.REMOVE,
        getVersionOwner(),
      );
    }
  }
}
