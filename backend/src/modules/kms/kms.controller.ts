import {
  Body,
  Controller,
  Get,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { EntitlementGuard } from '../licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../licensing/license.constants';

import { KmsProvisioningService } from './kms-provisioning.service';
import { SetCmkDto, SetKmsEnabledDto } from './dto/kms-config.dto';

/**
 * BYO-KMS admin API. Every route requires the `byo_kms` enterprise entitlement
 * (enforced by `EntitlementGuard` → 402 when unlicensed) and org owner/admin
 * role. No route ever returns key material — only the wrapped-DEK "provisioned"
 * flag and the public CMK ARN / region.
 */
@Controller('kms')
@ApiTags('KMS (BYO-KMS)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequiresEntitlement(EE_ENTITLEMENTS.BYO_KMS)
export class KmsController {
  constructor(private readonly provisioning: KmsProvisioningService) {}

  @Get()
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Get the org BYO-KMS configuration status' })
  async get(@Request() req: any) {
    const data = await this.provisioning.getConfig(
      req.user.currentOrganizationId,
    );
    return { success: true, data };
  }

  @Put()
  @Roles('admin', 'owner')
  @ApiOperation({
    summary: 'Attach or replace the customer-managed CMK (wraps a fresh DEK)',
  })
  async setCmk(@Request() req: any, @Body() body: SetCmkDto) {
    const data = await this.provisioning.setCmk(
      req.user.currentOrganizationId,
      { cmkArn: body.cmkArn, awsRegion: body.awsRegion, enabled: body.enabled },
    );
    return { success: true, data };
  }

  @Put('enabled')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Enable or disable the envelope-encryption path' })
  async setEnabled(@Request() req: any, @Body() body: SetKmsEnabledDto) {
    const data = await this.provisioning.setEnabled(
      req.user.currentOrganizationId,
      body.enabled,
    );
    return { success: true, data };
  }
}
