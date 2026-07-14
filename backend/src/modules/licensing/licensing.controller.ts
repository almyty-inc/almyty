import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { EntitlementSnapshot, LicenseService } from './license.service';
import { OrgLicenseResolver } from './org-license.resolver';

/**
 * Exposes the active entitlement set to authenticated clients so the frontend
 * can hide/lock EE-only UI. Entitlements are per-org: a paying org unlocks its
 * EE features via its stored license token. When the request carries an org
 * context we return that org's resolved snapshot; otherwise (no org selected)
 * we fall back to the process-global snapshot.
 */
@Controller('licensing')
@UseGuards(JwtAuthGuard)
export class LicensingController {
  constructor(
    private readonly licenseService: LicenseService,
    private readonly orgLicenseResolver: OrgLicenseResolver,
  ) {}

  @Get('entitlements')
  async getEntitlements(@Req() req: any): Promise<EntitlementSnapshot> {
    const organizationId: string | undefined = req?.user?.currentOrganizationId;
    if (organizationId) {
      return this.orgLicenseResolver.entitlementsForOrg(organizationId);
    }
    return this.licenseService.snapshot();
  }
}
