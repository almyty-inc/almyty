import { Injectable } from '@nestjs/common';

import { ConnectionsService } from './connections.service';
import { RotationRegistry } from './rotation/rotation.registry';

/**
 * What a scheduler (the EE governance job) sees of rotation: one call by
 * connection id, no actor, no secrets in or out. Kept in core so the EE
 * module binds its rotator token to this class instead of reaching into
 * the connections service.
 */
@Injectable()
export class ConnectionsRotatorBridge {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly registry: RotationRegistry,
  ) {}

  canRotate(connectorKey: string): boolean {
    return Boolean(this.registry.get(connectorKey)?.capabilities().create);
  }

  rotate(connectionId: string): Promise<{ rotated: boolean; manual?: boolean; error?: string }> {
    return this.connections.rotateAsSystem(connectionId);
  }
}
