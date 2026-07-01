import { Module } from '@nestjs/common';
import { ExampleEeController } from './example-ee.controller';

/**
 * PLACEHOLDER Enterprise Edition module. Registered in the app ONLY by the EE
 * build (see /LICENSING.md); the OSS build never compiles or loads `ee/`.
 * `LicenseService` + `EntitlementGuard` come from the global `LicensingModule`
 * in the core, so nothing extra needs importing here.
 */
@Module({
  controllers: [ExampleEeController],
})
export class ExampleEeModule {}
