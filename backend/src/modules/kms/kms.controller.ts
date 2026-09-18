import { Body, Controller, Get, Post, Put, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { EntitlementGuard } from '../licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../licensing/license.constants';

import { KmsProvisioningService } from './kms-provisioning.service';
import { RotateCmkDto, SetCmkDto, SetKmsEnabledDto } from './dto/kms-config.dto';

/**
 * BYO-KMS admin API. Every route requires the `byo_kms` enterprise entitlement
 * (enforced by `EntitlementGuard` → 402 when unlicensed) and org owner/admin
 * role. No route ever returns key material — only the wrapped-DEK
 * "provisioned" flag, the public CMK ARN / region, and the key ids, which are
 * fingerprints of blobs already at rest rather than anything secret.
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
    summary: 'Attach the customer-managed CMK (wraps a fresh DEK)',
    description:
      'Fails with 409 when a key is already attached — replacing one is a ' +
      'rotation, which retains the key it replaces. Use POST /kms/rotate.',
  })
  async setCmk(@Request() req: any, @Body() body: SetCmkDto) {
    const data = await this.provisioning.attachCmk(
      req.user.currentOrganizationId,
      { cmkArn: body.cmkArn, awsRegion: body.awsRegion, enabled: body.enabled },
    );
    return { success: true, data };
  }

  @Post('rotate')
  @Roles('admin', 'owner')
  @ApiOperation({
    summary: 'Rotate onto a fresh DEK, optionally under a different CMK',
    description:
      'The outgoing wrapped DEK is retained, so secrets sealed under it stay ' +
      'readable without being re-encrypted.',
  })
  async rotate(@Request() req: any, @Body() body: RotateCmkDto) {
    const data = await this.provisioning.rotateCmk(
      req.user.currentOrganizationId,
      { cmkArn: body.cmkArn, awsRegion: body.awsRegion },
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
