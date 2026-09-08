import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ModelVersion } from '../../entities/model-version.entity';
import { ModelDeployment } from '../../entities/model-deployment.entity';
import { Credential } from '../../entities/credential.entity';
import { Organization } from '../../entities/organization.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { KmsModule } from '../kms/kms.module';
import { ModelRegistryService } from './model-registry.service';
import { ModelVersionsService } from './model-versions.service';
import { ModelVersionsController } from './model-versions.controller';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([ModelVersion, ModelDeployment, Credential, Organization]), AuditLogModule, KmsModule],
  providers: [ModelRegistryService, ModelVersionsService],
  controllers: [ModelVersionsController],
  exports: [ModelRegistryService, ModelVersionsService],
})
export class ModelRegistryModule {}
