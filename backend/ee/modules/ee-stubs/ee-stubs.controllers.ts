import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../src/modules/auth/guards/roles.guard';
import { Roles } from '../../../src/modules/auth/decorators/roles.decorator';
import { EntitlementGuard } from '../../../src/modules/licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../../../src/modules/licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';

/**
 * Shared 501 body. The remaining feature here is an entitlement-gated
 * scaffold: the `EntitlementGuard` runs first (→ 402 without a license),
 * and only a licensed caller reaches the handler, which then reports the
 * feature is not yet implemented (→ 501). This keeps the gate wiring +
 * surface area testable now while the implementation is a documented
 * follow-up.
 *
 * compliance_pack (→ modules/compliance) and chargeback (→ modules/chargeback)
 * have since been implemented and removed from this stub module.
 */
function notImplemented(feature: string): never {
  throw new HttpException(
    {
      statusCode: HttpStatus.NOT_IMPLEMENTED,
      error: 'Not Implemented',
      message: `${feature} is licensed but not yet implemented (P5 follow-up).`,
    },
    HttpStatus.NOT_IMPLEMENTED,
  );
}

/**
 * EE (byo_kms): customer-managed encryption key + data residency.
 * Follow-up (issue #239): route the credential/llm-key envelope encryption
 * through a customer-owned AWS KMS CMK. Requires live AWS KMS credentials
 * to build and verify — blocked until those are provisioned. Stub only.
 */
@Controller('byo-kms')
@ApiTags('BYO-KMS (EE)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequiresEntitlement(EE_ENTITLEMENTS.BYO_KMS)
@Roles('admin', 'owner')
export class ByoKmsController {
  @Get('config')
  @ApiOperation({ summary: 'Get the customer-managed KMS config (stub)' })
  getConfig() {
    notImplemented('BYO-KMS');
  }
}