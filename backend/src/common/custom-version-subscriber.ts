import {
  EventSubscriber,
  EntitySubscriberInterface,
  InsertEvent,
  UpdateEvent,
  RemoveEvent,
} from 'typeorm';
import { isVersionedEntity } from 'typeorm-versions';
import { VersionRepository } from 'typeorm-versions';
import { VersionEvent } from 'typeorm-versions';
import { getVersionOwner } from './version-context';

@EventSubscriber()
export class CustomVersionSubscriber implements EntitySubscriberInterface {
  async afterInsert(event: InsertEvent<any>) {
    if (isVersionedEntity(event.entity)) {
      await VersionRepository(event.connection).saveVersion(
        event.entity,
        VersionEvent.INSERT,
        getVersionOwner(),
      );
    }
  }

  async afterUpdate(event: UpdateEvent<any>) {
    if (event.entity && isVersionedEntity(event.entity)) {
      await VersionRepository(event.connection).saveVersion(
        event.entity,
        VersionEvent.UPDATE,
        getVersionOwner(),
      );
    }
  }

  async beforeRemove(event: RemoveEvent<any>) {
    if (event.entity && isVersionedEntity(event.entity)) {
      await VersionRepository(event.connection).saveVersion(
        event.entity,
        VersionEvent.REMOVE,
        getVersionOwner(),
      );
    }
  }
}
