import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../backend/src/modules/auth/guards/jwt-auth.guard';
import { EntitlementGuard } from '../../backend/src/modules/licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../../backend/src/modules/licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../../backend/src/modules/licensing/license.constants';

/**
 * PLACEHOLDER Enterprise Edition endpoint. Demonstrates the open-core boundary:
 * this controller lives under `ee/` (commercial, excluded from the OSS build)
 * and is gated at runtime by `@RequiresEntitlement`. Without a license that
 * grants `example_ee_feature`, `EntitlementGuard` returns 402 Payment Required.
 *
 * Real EE features (SSO, advanced RBAC, audit export, ...) follow this exact
 * shape. See /LICENSING.md.
 */
@Controller('ee/example')
@UseGuards(JwtAuthGuard, EntitlementGuard)
export class ExampleEeController {
  @Get()
  @RequiresEntitlement(EE_ENTITLEMENTS.EXAMPLE_EE_FEATURE)
  getExample(): { feature: string; message: string } {
    return {
      feature: EE_ENTITLEMENTS.EXAMPLE_EE_FEATURE,
      message: 'This response is only reachable with a valid EE license entitlement.',
    };
  }
}
