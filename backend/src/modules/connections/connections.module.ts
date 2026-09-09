import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Credential } from '../../entities/credential.entity';
import { Organization } from '../../entities/organization.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { KmsModule } from '../kms/kms.module';
import { ModelDeploymentsModule } from '../model-deployments/model-deployments.module';
import { ConnectStateStoreFactory } from './connect-state.store';
import { ConnectionValidationService } from './connection-validation.service';
import { ConnectionsResolverService } from './connections-resolver.service';
import { ConnectionsController, ConnectorsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { ConnectorCatalogService } from './connector-catalog.service';
import { CustomConnector } from './connector.entity';
import { GrantsModule } from './grants/grants.module';
import { RotationModule } from './rotation/rotation.module';
import { ConnectionsRotatorBridge } from './connections-rotator.bridge';

/**
 * Connections, gate 1: connector catalog, connect / validate / rotate /
 * disconnect over Credential rows, PKCE state, and the resolver seam
 * consumers (gate 3) and grants (gate 2) build on.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Credential, CustomConnector, Organization]),
    AuditLogModule,
    KmsModule,
    ModelDeploymentsModule,
    GrantsModule,
    RotationModule,
  ],
  controllers: [ConnectorsController, ConnectionsController],
  providers: [
    ConnectorCatalogService,
    ConnectionValidationService,
    ConnectStateStoreFactory,
    ConnectionsService,
    ConnectionsResolverService,
    ConnectionsRotatorBridge,
  ],
  exports: [ConnectionsService, ConnectionsResolverService, ConnectorCatalogService, ConnectionValidationService, ConnectionsRotatorBridge, GrantsModule, RotationModule],
})
export class ConnectionsModule {}
