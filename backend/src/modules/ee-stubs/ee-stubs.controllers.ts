import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { EntitlementGuard } from '../licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../licensing/license.constants';

/**
 * Shared 501 body. These features are entitlement-gated scaffolds: the
 * `EntitlementGuard` runs first (→ 402 without a license), and only a
 * licensed caller reaches the handler, which then reports the feature is
 * not yet implemented (→ 501). This keeps the gate wiring + surface area
 * testable now while the implementation is a documented follow-up.
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
 * EE (compliance_pack): org-wide enforced pii-filter / security-scanner /
 * guardrail policy + reporting. Follow-up: wrap the existing built-in
 * pii-filter and security-scanner plugins as an enforced org policy layer
 * with a compliance report. Stub only.
 */
@Controller('compliance')
@ApiTags('Compliance Pack (EE)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequiresEntitlement(EE_ENTITLEMENTS.COMPLIANCE_PACK)
@Roles('admin', 'owner')
export class ComplianceController {
  @Get('policy')
  @ApiOperation({ summary: 'Get the enforced org compliance policy (stub)' })
  getPolicy() {
    notImplemented('Compliance pack');
  }
}

/**
 * EE (chargeback): chargeback / showback / forecasting. Follow-up:
 * extend the P2 spend-budgets + spend aggregation to attribute cost per
 * team/agent/user and forecast. Stub only.
 */
@Controller('chargeback')
@ApiTags('Chargeback (EE)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequiresEntitlement(EE_ENTITLEMENTS.CHARGEBACK)
@Roles('admin', 'owner')
export class ChargebackController {
  @Get('report')
  @ApiOperation({ summary: 'Get a chargeback/showback report (stub)' })
  getReport() {
    notImplemented('Chargeback');
  }
}

/**
 * EE (byo_kms): customer-managed encryption key + data residency.
 * Follow-up: route the credential/llm-key envelope encryption through a
 * customer-owned AWS KMS CMK. Requires live AWS KMS credentials to build
 * and verify — blocked until those are provisioned. Stub only.
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
