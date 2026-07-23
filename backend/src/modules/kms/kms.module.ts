import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrgKmsConfig } from '../../entities/org-kms-config.entity';
import { KmsClientFactory } from './kms.service';
import { EnvelopeCryptoService } from './envelope-crypto.service';
import { KmsProvisioningService } from './kms-provisioning.service';
import { KmsController } from './kms.controller';

/**
 * BYO-KMS (customer-managed CMK) envelope encryption.
 *
 * `EnvelopeCryptoService` is exported so any module that stores org-scoped
 * secrets can route them through the customer's CMK when configured, while
 * transparently falling back to the platform-managed field-crypto key
 * otherwise. `LicensingModule` is @Global, so `OrgLicenseResolver` (used to
 * check the `byo_kms` entitlement per org) is injectable without importing it.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([OrgKmsConfig])],
  controllers: [KmsController],
  providers: [KmsClientFactory, EnvelopeCryptoService, KmsProvisioningService],
  exports: [EnvelopeCryptoService, KmsProvisioningService],
})
export class KmsModule {}
