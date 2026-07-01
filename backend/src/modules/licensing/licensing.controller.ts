import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { EntitlementSnapshot, LicenseService } from './license.service';

/**
 * Exposes the active entitlement set to authenticated clients so the frontend
 * can hide/lock EE-only UI. Feature flags are deployment-wide (one license per
 * deployment), not per-org, and non-sensitive — but we still require auth to
 * match the rest of the app's posture.
 */
@Controller('licensing')
@UseGuards(JwtAuthGuard)
export class LicensingController {
  constructor(private readonly licenseService: LicenseService) {}

  @Get('entitlements')
  getEntitlements(): EntitlementSnapshot {
    return this.licenseService.snapshot();
  }
}
