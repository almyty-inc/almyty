import { Module } from '@nestjs/common';

import { AuditLogModule } from '../../audit-log/audit-log.module';
import { builtInRotations } from './providers';
import { defaultRotationHttp } from './rotation.http';
import { ROTATION_HTTP, RotationHttp } from './rotation.interface';
import { RotationRegistry } from './rotation.registry';
import { RotationService } from './rotation.service';

/**
 * Connections gate 5. ConnectionsModule imports this and calls
 * RotationService from POST /connections/:id/rotate and
 * DELETE /connections/:id; the EE scheduler will call the same methods
 * on a timer. Specs build the registry by hand with a fixture HTTP.
 */
export function buildRotationRegistry(http: RotationHttp): RotationRegistry {
  const registry = new RotationRegistry();
  for (const provider of builtInRotations(http)) registry.register(provider);
  return registry;
}

@Module({
  imports: [AuditLogModule],
  providers: [
    { provide: ROTATION_HTTP, useFactory: defaultRotationHttp },
    { provide: RotationRegistry, useFactory: buildRotationRegistry, inject: [ROTATION_HTTP] },
    RotationService,
  ],
  exports: [RotationRegistry, RotationService, ROTATION_HTTP],
})
export class RotationModule {}
